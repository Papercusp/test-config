import { homedir, hostname, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { accessSync, constants as fsConstants, mkdirSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { recordTestcontainerUse, resolveTestcontainerLastUsedRoot } from './testcontainer-last-used.ts';

/**
 * The default wait budget is part of the test-fixture contract: callers that
 * wrap startup in an outer Vitest hook must leave enough headroom for the
 * lock's diagnostic to be reported instead of having Vitest cancel first.
 */
export const TESTCONTAINER_START_LOCK_TIMEOUT_MS = 180_000;
/**
 * Keep one wedged Docker API request from outliving the cross-process startup
 * lock. docker-modem reads DOCKER_CLIENT_TIMEOUT when it constructs its shared
 * client and destroys a request whose response exceeds this many milliseconds.
 * Leave one minute of headroom for the lock's own 180s diagnostic/cleanup.
 */
export const TESTCONTAINERS_DOCKER_CLIENT_TIMEOUT_MS = 120_000;
const DEFAULT_RETRY_MS = 250;

export function ensureTestcontainersDockerClientTimeout(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const configured = Number(env.DOCKER_CLIENT_TIMEOUT);
  if (Number.isSafeInteger(configured) && configured > 0) return configured;
  env.DOCKER_CLIENT_TIMEOUT = String(TESTCONTAINERS_DOCKER_CLIENT_TIMEOUT_MS);
  return TESTCONTAINERS_DOCKER_CLIENT_TIMEOUT_MS;
}

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

// EI (2026-07-12): this used to hardcode '/tmp/pcv/testcontainers-locks',
// duplicating (and drifting from) the writable-tmp choice vitest-config.ts
// already makes via TMPDIR. On a box/sandbox where the writable scratch tmp
// moved (e.g. a per-agent exec sandbox that mounts bare /tmp read-only and
// carves out a DIFFERENT writable dir, such as /tmp/claude, as TMPDIR),
// vitest-config.ts correctly follows TMPDIR — but this hardcoded fallback did
// not, so `mkdir(root)` threw EROFS even though the process's own TMPDIR was
// perfectly writable. Deriving from tmpdir() (which honors TMPDIR/TMP/TEMP)
// keeps this in sync with whatever writable tmp the rest of the test harness
// already resolved, instead of re-guessing a second time.
//
// WI-6554700010008428 (2026-10-11): following tmpdir() alone split ONE box-level root in
// two. The test router runs Vitest with TMPDIR=/tmp/pcv, so its processes used
// /tmp/pcv/pcv/testcontainers-locks, while a host shell with TMPDIR unset used
// /tmp/pcv/testcontainers-locks. Both directories held their own reuse-generation file, so
// a rotation in one was invisible to the other, and the start lock did not serialize them.
// scripts/lib/fs-mutex.mjs hit the same split for the npm-install mutex (WI-40965) and fixed
// it with a host-stable default. Do the same here, and fall back to the tmpdir()-derived root
// only when the stable one is not writable: that is the read-only-/tmp sandbox above.
const STABLE_POSIX_LOCK_ROOT = '/tmp/pcv/testcontainers-locks';

export interface TestcontainerStartLockRootOptions {
  platform?: NodeJS.Platform;
  homeDir?: string;
  tmpDir?: string;
  isWritableDir?: (dir: string) => boolean;
}

function isWritableDirSync(dir: string): boolean {
  try {
    mkdirSync(dir, { recursive: true });
    accessSync(dir, fsConstants.W_OK);
    return true;
  } catch {
    return false;
  }
}

export function resolveTestcontainerStartLockRoot(
  env: NodeJS.ProcessEnv = process.env,
  opts: TestcontainerStartLockRootOptions = {},
): string {
  if (env.PAPERCUSP_TESTCONTAINERS_LOCK_DIR) return resolve(env.PAPERCUSP_TESTCONTAINERS_LOCK_DIR);
  const stable = (opts.platform ?? process.platform) === 'win32'
    ? join(opts.homeDir ?? homedir(), '.papercusp', 'testcontainers-locks')
    : STABLE_POSIX_LOCK_ROOT;
  if ((opts.isWritableDir ?? isWritableDirSync)(stable)) return stable;
  return resolve(join(opts.tmpDir ?? tmpdir(), 'pcv', 'testcontainers-locks'));
}

export function testcontainerStartLockRoot(): string {
  return resolveTestcontainerStartLockRoot();
}

function safeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, '_');
}

async function readOwner(lockDir: string): Promise<string> {
  try {
    return await readFile(join(lockDir, 'owner.json'), 'utf8');
  } catch {
    return '(owner unknown)';
  }
}

type LinuxProcessIdentity = {
  tgid: number;
  startTicks: string;
  bootId: string;
};

/**
 * Return the kernel identity for a Linux process, or null where /proc is not
 * available. PID alone can refer to a different process after reuse; the
 * start ticks and boot id distinguish that new process from the lock owner.
 */
async function readLinuxProcessIdentity(pid: number): Promise<LinuxProcessIdentity | null> {
  try {
    const [status, stat, bootIdText] = await Promise.all([
      readFile(`/proc/${pid}/status`, 'utf8'),
      readFile(`/proc/${pid}/stat`, 'utf8'),
      readFile('/proc/sys/kernel/random/boot_id', 'utf8'),
    ]);
    const tgid = Number(/^Tgid:\s*(\d+)$/m.exec(status)?.[1]);
    // The comm field is parenthesized and may contain spaces or parentheses;
    // parse fields only after its final closing parenthesis. Field 22 is index
    // 19 when the remaining fields start at field 3.
    const startTicks = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/)[19];
    const bootId = bootIdText.trim();
    if (!Number.isSafeInteger(tgid) || tgid <= 0 || !/^\d+$/.test(startTicks ?? '') || !bootId) return null;
    return { tgid, startTicks, bootId };
  } catch {
    // Non-Linux platforms and restricted /proc mounts retain kill(pid, 0)'s
    // conservative behavior: inability to inspect identity never proves death.
    return null;
  }
}

/**
 * True only when we can POSITIVELY confirm the lock's recorded owner process is
 * dead: same host (a cross-host pid means nothing — never claim dead across
 * hosts), `process.kill(pid, 0)` reports ESRCH, or a live numeric PID now has a
 * different recorded Linux kernel identity. Any other outcome (different host,
 * legacy/malformed identity, EPERM/alive, or any other error) returns false —
 * this must never produce a false "dead" that reclaims a live holder's lock.
 */
async function isOwnerProcessConfirmedDead(lockDir: string): Promise<boolean> {
  let raw: string;
  try {
    raw = await readFile(join(lockDir, 'owner.json'), 'utf8');
  } catch {
    return false;
  }
  let owner: {
    pid?: unknown;
    host?: unknown;
    tgid?: unknown;
    startTicks?: unknown;
    bootId?: unknown;
  };
  try {
    owner = JSON.parse(raw);
  } catch {
    return false;
  }
  if (typeof owner.pid !== 'number' || typeof owner.host !== 'string') return false;
  if (owner.host !== hostname()) return false;
  try {
    process.kill(owner.pid, 0);
    const completeIdentity = Number.isSafeInteger(owner.tgid) && owner.tgid === owner.pid &&
      typeof owner.startTicks === 'string' && /^\d+$/.test(owner.startTicks) &&
      typeof owner.bootId === 'string' && owner.bootId.length > 0;
    if (completeIdentity) {
      const current = await readLinuxProcessIdentity(owner.pid);
      if (current && (current.tgid !== owner.pid || current.tgid !== owner.tgid ||
          current.startTicks !== owner.startTicks || current.bootId !== owner.bootId)) {
        return true; // this PID is live, but it is not the recorded lock owner
      }
    }
    return false; // no throw ⇒ process exists; unknown or matching identity stays held
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH';
  }
}

export interface TestcontainerStartLockOptions {
  timeoutMs?: number;
  staleMs?: number;
  retryMs?: number;
}

/**
 * Serialize local Testcontainers startup across concurrent Vitest processes.
 *
 * The containers themselves may be reusable, but the Docker/Testcontainers
 * handshake is still host-local work. Under large agent fleets, many separate
 * Vitest processes can hit that handshake at once and stall before user setup
 * code runs. This lock is intentionally filesystem-local so it works from plain
 * test processes with no Papercusp/MCP credentials.
 */
export async function withTestcontainerStartLock<T>(
  name: string,
  start: () => Promise<T>,
  opts: TestcontainerStartLockOptions = {},
): Promise<T> {
  // Set this before `start` can construct Testcontainers' process-wide
  // Dockerode client. Without it, docker-modem has no response timeout: a
  // single fetch/create/start request can hold this fleet-wide lock forever.
  ensureTestcontainersDockerClientTimeout();
  const root = testcontainerStartLockRoot();
  // WI-6554700010009309: stamp every container this start resolved (created or
  // reused) so the hourly docker reclaim can tell a used container from a
  // leaked one. Best-effort; never fails the start.
  const startAndRecordUse = async (): Promise<T> => {
    const result = await start();
    await recordTestcontainerUse(result, resolveTestcontainerLastUsedRoot(root));
    return result;
  };
  if (process.env.PAPERCUSP_DISABLE_TESTCONTAINERS_START_LOCK === '1') {
    return startAndRecordUse();
  }

  const lockDir = join(root, `${safeName(name)}.lock`);
  const timeoutMs = opts.timeoutMs ?? intEnv(
    'PAPERCUSP_TESTCONTAINERS_START_LOCK_TIMEOUT_MS',
    TESTCONTAINER_START_LOCK_TIMEOUT_MS,
  );
  const retryMs = opts.retryMs ?? intEnv('PAPERCUSP_TESTCONTAINERS_START_LOCK_RETRY_MS', DEFAULT_RETRY_MS);
  const startedAt = Date.now();
  const kernelIdentity = await readLinuxProcessIdentity(process.pid);
  const owner = {
    pid: process.pid,
    host: hostname(),
    startedAt: new Date(startedAt).toISOString(),
    name,
    ...(kernelIdentity ?? {}),
  };

  await mkdir(root, { recursive: true });

  for (;;) {
    try {
      await mkdir(lockDir);
      await writeFile(join(lockDir, 'owner.json'), `${JSON.stringify(owner, null, 2)}\n`);
      break;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST') throw error;

      const elapsed = Date.now() - startedAt;
      // A live startup can exceed ten minutes. Age alone must never take its
      // lock away: a second process would then enter the same critical section.
      // Reclaim only with positive same-host dead-process evidence.
      if (await isOwnerProcessConfirmedDead(lockDir)) {
        await rm(lockDir, { recursive: true, force: true });
        continue;
      }

      if (elapsed > timeoutMs) {
        const currentOwner = await readOwner(lockDir);
        throw new Error(
          `Timed out after ${timeoutMs}ms waiting for Testcontainers startup lock ${lockDir}; holder: ${currentOwner}`,
        );
      }

      await sleep(retryMs);
    }
  }

  try {
    return await startAndRecordUse();
  } finally {
    await rm(lockDir, { recursive: true, force: true });
  }
}
