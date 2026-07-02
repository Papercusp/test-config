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
 *  - PAPERCUSP_HIVE_HOME_SLUG — the operator-home harness pointer
 *    (operatorHomeHarnessSlug() reads it LIVE, no cache). Tests asserting the UNSET
 *    fallback ('no pointer → the legacy default "papercusp"') get a leaked value
 *    instead. The leak is cross-FILE, not spawn-env: sibling tests (hive/*,
 *    *-workspace-scope, overwatch/*) set it inside their tests and clean up only in
 *    beforeEach (start of the NEXT test) — so after a file's LAST setting test it
 *    stays set, and vitest's `forks` pool REUSES the worker for the next file,
 *    leaking the value in (2026-06-30: green-checkpoint redded overwatch/loop +
 *    fallback suites that pass in isolation, seeing 'ws-1'/'env-slug'). Scrubbing at
 *    each file's start makes the UNSET default reliable; a test that needs a pin
 *    sets it itself.
 *
 *  - PAPERCUSP_VOICE_IPC_DIR (redirected, not scrubbed) — the voice-socket state root
 *    (sockets/ + voice-ipc.json). Without a redirect, any test that (transitively)
 *    starts the local voice socket reaps the REAL ~/.papercusp/sockets — an orphaned
 *    socket on the host then emits a GC console.error that vitest-fail-on-console turns
 *    into a red (2026-07-01: 3,889 orphaned sockets on the dev box redded
 *    local-audio-socket in the green-checkpoint) — and overwrites the live
 *    ~/.papercusp/voice-ipc.json discovery file out from under the running operator.
 *    Redirect to a per-worker tmpdir. THE PATTERN: unit tests must never read/write the
 *    real ~/.papercusp; any state-path env seam (PAPERCUSP_*_DIR) that keeps them out of
 *    it belongs in this block, redirected to a tmpdir the same way.
 *
 * Keep this list to PROVEN leak classes — broad env wipes hide real bugs.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.PAPERCUSP_PGBOUNCER ??= '0';
process.env.PAPERCUSP_VOICE_IPC_DIR ??= mkdtempSync(join(tmpdir(), 'voice-ipc-hermetic-'));
delete process.env.PAPERCUSP_WORKSPACE_ID;
delete process.env.PAPERCUSP_HIVE_HOME_SLUG;
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
