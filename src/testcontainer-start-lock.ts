import { hostname, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';

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
export function testcontainerStartLockRoot(): string {
  return resolve(process.env.PAPERCUSP_TESTCONTAINERS_LOCK_DIR ?? join(tmpdir(), 'pcv', 'testcontainers-locks'));
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

/**
 * True only when we can POSITIVELY confirm the lock's recorded owner process is
 * dead: same host (a cross-host pid means nothing — never claim dead across
 * hosts) AND `process.kill(pid, 0)` reports ESRCH (no such process). Any other
 * outcome (different host, unparseable owner.json, EPERM/alive, or any other
 * error) returns false — this must never produce a false "dead" that reclaims a
 * live holder's lock.
 */
async function isOwnerProcessConfirmedDead(lockDir: string): Promise<boolean> {
  let raw: string;
  try {
    raw = await readFile(join(lockDir, 'owner.json'), 'utf8');
  } catch {
    return false;
  }
  let owner: { pid?: unknown; host?: unknown };
  try {
    owner = JSON.parse(raw);
  } catch {
    return false;
  }
  if (typeof owner.pid !== 'number' || typeof owner.host !== 'string') return false;
  if (owner.host !== hostname()) return false;
  try {
    process.kill(owner.pid, 0);
    return false; // no throw ⇒ signal delivered ⇒ process exists (or we lack permission ⇒ assume alive)
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
  if (process.env.PAPERCUSP_DISABLE_TESTCONTAINERS_START_LOCK === '1') {
    return start();
  }

  const root = testcontainerStartLockRoot();
  const lockDir = join(root, `${safeName(name)}.lock`);
  const timeoutMs = opts.timeoutMs ?? intEnv(
    'PAPERCUSP_TESTCONTAINERS_START_LOCK_TIMEOUT_MS',
    TESTCONTAINER_START_LOCK_TIMEOUT_MS,
  );
  const retryMs = opts.retryMs ?? intEnv('PAPERCUSP_TESTCONTAINERS_START_LOCK_RETRY_MS', DEFAULT_RETRY_MS);
  const startedAt = Date.now();
  const owner = {
    pid: process.pid,
    host: hostname(),
    startedAt: new Date(startedAt).toISOString(),
    name,
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
    return await start();
  } finally {
    await rm(lockDir, { recursive: true, force: true });
  }
}
