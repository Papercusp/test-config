import { dirname, join, resolve } from 'node:path';
import { mkdir, utimes, writeFile } from 'node:fs/promises';

/**
 * Last-use markers for Testcontainers (WI-6554700010009309, plan
 * papercusp-performance-audit-2026-10-12 P-009).
 *
 * WHY: every shared helper in this package starts its container with
 * `.withReuse()`, and the integration layer runs with Ryuk disabled
 * (`TESTCONTAINERS_RYUK_DISABLED=true`). A reused container is meant to
 * outlive the process that started it, so nothing ever removes one. A
 * container whose reuse hash stops matching (an image bump, a moved
 * generation label, a duplicate created by a start race) is orphaned for good.
 * On 2026-10-13, 9 `org.testcontainers=true` containers were running; up to 5
 * of them had been idle for days, the oldest 17 days.
 *
 * Process liveness cannot tell an orphan from the shared reused test PG. A
 * reused container has no owning process between runs, and both are idle with
 * zero connections. What does tell them apart is USE: the shared container
 * is resolved again by every Vitest process, while an orphan never is.
 * So each successful start stamps `<root>/<container id>` with the current
 * time. The hourly `bin/reclaim-docker-disk.sh` removes a testcontainer only when its
 * marker is older than the idle threshold AND it has no established
 * connection. Recording is best-effort and must never fail a test run.
 */

export const TESTCONTAINERS_LAST_USED_DIR_ENV = 'PAPERCUSP_TESTCONTAINERS_LAST_USED_DIR';

const CONTAINER_ID = /^[0-9a-f]{64}$/;

/**
 * The marker directory is a SIBLING of the start-lock root, so it inherits
 * that root's host-stable resolution (`/tmp/pcv/...` on POSIX). The reaper in
 * `bin/reclaim-docker-disk.sh` reads the same default path.
 */
export function resolveTestcontainerLastUsedRoot(
  lockRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const override = env[TESTCONTAINERS_LAST_USED_DIR_ENV];
  if (override) return resolve(override);
  return join(dirname(resolve(lockRoot)), 'testcontainers-last-used');
}

function idOf(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null;
  const getId = (value as { getId?: unknown }).getId;
  if (typeof getId !== 'function') return null;
  try {
    const id = getId.call(value);
    return typeof id === 'string' && CONTAINER_ID.test(id) ? id : null;
  } catch {
    return null;
  }
}

/**
 * Container ids carried by a start-lock action's result: the result itself
 * when it is a started container, otherwise any started container among its
 * own fields (the baseline-schema setup returns `{ c, generation }`).
 */
export function startedContainerIds(result: unknown): string[] {
  const direct = idOf(result);
  if (direct) return [direct];
  if (!result || typeof result !== 'object') return [];
  const ids = new Set<string>();
  for (const value of Object.values(result as Record<string, unknown>)) {
    const id = idOf(value);
    if (id) ids.add(id);
  }
  return [...ids];
}

/** Stamp each container id carried by `result` as used now. Never throws. */
export async function recordTestcontainerUse(
  result: unknown,
  root: string,
  now: Date = new Date(),
): Promise<string[]> {
  const ids = startedContainerIds(result);
  if (ids.length === 0) return [];
  try {
    await mkdir(root, { recursive: true });
  } catch {
    return [];
  }
  const recorded: string[] = [];
  for (const id of ids) {
    const marker = join(root, id);
    try {
      await utimes(marker, now, now);
      recorded.push(id);
    } catch {
      try {
        await writeFile(marker, '');
        await utimes(marker, now, now);
        recorded.push(id);
      } catch {
        // Best-effort: a missed stamp costs at most one container re-creation
        // after the idle threshold, never a failed test.
      }
    }
  }
  return recorded;
}
