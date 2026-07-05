import { hostname } from 'node:os';
import { join, resolve } from 'node:path';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';

const DEFAULT_TIMEOUT_MS = 180_000;
const DEFAULT_STALE_MS = 10 * 60_000;
const DEFAULT_RETRY_MS = 250;

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function lockRoot(): string {
  return resolve(process.env.PAPERCUSP_TESTCONTAINERS_LOCK_DIR ?? '/tmp/pcv/testcontainers-locks');
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
  if (process.env.PAPERCUSP_DISABLE_TESTCONTAINERS_START_LOCK === '1') {
    return start();
  }

  const root = lockRoot();
  const lockDir = join(root, `${safeName(name)}.lock`);
  const timeoutMs = opts.timeoutMs ?? intEnv('PAPERCUSP_TESTCONTAINERS_START_LOCK_TIMEOUT_MS', DEFAULT_TIMEOUT_MS);
  const staleMs = opts.staleMs ?? intEnv('PAPERCUSP_TESTCONTAINERS_START_LOCK_STALE_MS', DEFAULT_STALE_MS);
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
      const lockAgeMs = await stat(lockDir)
        .then((s) => Date.now() - s.mtimeMs)
        .catch(() => 0);
      if (lockAgeMs > staleMs) {
        await rm(lockDir, { recursive: true, force: true });
        continue;
      }

      // EI-7818: age-based staleness (above) can NEVER fire under the DEFAULT
      // config, because DEFAULT_TIMEOUT_MS (180s) is smaller than DEFAULT_STALE_MS
      // (600s) — a caller always hits its own `elapsed > timeoutMs` throw below
      // long before the lock is old enough to be judged stale, so a crashed
      // holder's lock wedges EVERY subsequent caller for a full timeoutMs, FOREVER
      // (reproduced live 2026-07-05: a dead pid's lock, ~9 min old, had already
      // failed two separate 180s/400s-wrapped waits without ever reclaiming).
      // Reclaim immediately, independent of age, the moment we can POSITIVELY
      // confirm the recorded owner process no longer exists (same host + ESRCH) —
      // this closes the gap the timing race leaves open without needing to guess
      // at timeout/stale constant tuning.
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
