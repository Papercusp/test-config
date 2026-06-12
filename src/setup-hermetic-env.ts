/**
 * Scrubs agent-spawn env pollution so tests behave identically under any
 * runner (dev shell, CI, an orchestrator-SPAWNED agent like the hourly
 * green-checkpoint). Spawned agents carry per-spawn env pins that leak into
 * vitest and break env-sensitive tests in ways a local re-run can't reproduce
 * (2026-06-11: the green-checkpoint repeatedly redded run-git-sync +
 * workspace-fallback suites that pass everywhere else):
 *
 *  - PAPERCUSP_WORKSPACE_ID — the orchestrator's process workspace pin
 *    (workspace-registry precedence step 2). Tests asserting the global
 *    fallback ('no header → registry default') get the spawn's pin instead.
 *    Tests that need a pin set it themselves (and those pass it explicitly).
 *
 *  - GIT_CONFIG_COUNT / GIT_CONFIG_KEY_n / GIT_CONFIG_VALUE_n — the spawn-env
 *    git-config injection that mounts the fleet no-push pre-push hook
 *    (orchestrator invoke.ts gitConfigNoPushEnv). Real-git tests (run-git-sync)
 *    inherit it into their /tmp repos and every push is blocked.
 *
 * Keep this list to PROVEN leak classes — broad env wipes hide real bugs.
 */
delete process.env.PAPERCUSP_WORKSPACE_ID;

const gitConfigCount = Number.parseInt(process.env.GIT_CONFIG_COUNT ?? '', 10);
if (Number.isFinite(gitConfigCount) && gitConfigCount > 0) {
  for (let i = 0; i < gitConfigCount; i++) {
    delete process.env[`GIT_CONFIG_KEY_${i}`];
    delete process.env[`GIT_CONFIG_VALUE_${i}`];
  }
  delete process.env.GIT_CONFIG_COUNT;
}
