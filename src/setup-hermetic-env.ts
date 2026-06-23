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
 *  - PAPERCUSP_INTEGRATION_ROOT / RELEASE_ROOT / CHECKPOINT_ROOT /
 *    INTEGRATION_BRANCH / RELEASE_REF — the release-gate workspace-map config
 *    carried by gate/checkpoint runner envs. resolveWorkspaceMapConfig prefers
 *    them over sibling derivation, so workspace-map tests asserting derivation
 *    get the runner's real paths (third 2026-06-11 checkpoint red).
 *
 *  - PAPERCUSP_PGBOUNCER (derived, not pinned) — `pgbouncerEnabled()` defaults ON for a
 *    SERVER-class host (the dev box / a dedicated CI server) even when the env is unset, so
 *    `getOrgPg()`'s `maybePgbouncer()` rewrites every org connection to 127.0.0.1:6432 — the
 *    host's pooler. Integration tests point getOrgPg at a throwaway TESTCONTAINER with NO
 *    bouncer, so the reroute hits the WRONG Postgres: a FATAL 08P01 under transaction pooling,
 *    or "no such database: org_<rand>" against the host PG (and silently pollutes it). The
 *    classic "green in CI (workstation-class), red on the dev box (server-class)" leak. Pin it
 *    OFF as the test default; a test that genuinely exercises the bouncer path sets
 *    PAPERCUSP_PGBOUNCER itself (the `??=` respects an explicit value).
 *
 * Keep this list to PROVEN leak classes — broad env wipes hide real bugs.
 */
process.env.PAPERCUSP_PGBOUNCER ??= '0';
delete process.env.PAPERCUSP_WORKSPACE_ID;
delete process.env.PAPERCUSP_INTEGRATION_ROOT;
delete process.env.PAPERCUSP_RELEASE_ROOT;
delete process.env.PAPERCUSP_CHECKPOINT_ROOT;
delete process.env.PAPERCUSP_INTEGRATION_BRANCH;
delete process.env.PAPERCUSP_RELEASE_REF;

const gitConfigCount = Number.parseInt(process.env.GIT_CONFIG_COUNT ?? '', 10);
if (Number.isFinite(gitConfigCount) && gitConfigCount > 0) {
  for (let i = 0; i < gitConfigCount; i++) {
    delete process.env[`GIT_CONFIG_KEY_${i}`];
    delete process.env[`GIT_CONFIG_VALUE_${i}`];
  }
  delete process.env.GIT_CONFIG_COUNT;
}
