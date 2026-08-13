/**
 * Also pins OUTBOUND THIRD-PARTY TELEMETRY off — see MEM0_TELEMETRY below.
 *
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
 *  - PAPERCUSP_PGBOUNCER (unconditionally scrubbed, like every var above) — `pgbouncerEnabled()`
 *    defaults ON for a SERVER-class host (the dev box / a dedicated CI server) even when the env
 *    is unset, so `getOrgPg()`'s `maybePgbouncer()` rewrites every org connection to
 *    127.0.0.1:6432 — the host's pooler. Integration tests point getOrgPg at a throwaway
 *    TESTCONTAINER with NO bouncer, so the reroute hits the WRONG Postgres: a FATAL 08P01 under
 *    transaction pooling, or "no such database: org_<rand>" (PgBouncer's own reject message for a
 *    db name outside its pool list) against the host's real pooler (and silently pollutes the
 *    host's real native PG). The classic "green in CI (workstation-class), red on the dev box
 *    (server-class)" leak (WI-2839: seed-any-hive.integration.test.ts 13/13 red this way).
 *    Originally used `??=` reasoning "a test that genuinely exercises the bouncer path sets it
 *    itself" — but that's the SAME agent-spawn-pollution class as PAPERCUSP_WORKSPACE_ID above: an
 *    orchestrator/spawn env can hand a running process an already-set '1' (server-class default)
 *    before vitest ever starts, and `??=` can't see past that. Force it OFF unconditionally, same
 *    as every other var in this file — a test that genuinely exercises the bouncer path still sets
 *    PAPERCUSP_PGBOUNCER itself in its OWN beforeAll/test body, which runs AFTER this file's
 *    module-level scrub and so still wins.
 *
 *  - PAPERCUSP_POT_HOME_SLUG — the operator-home harness pointer
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
 *  - PAPERCUSP_BACKGROUND_WORKERS / PAPERCUSP_HONO_PORT — every su/psu agent shell on
 *    this box carries `PAPERCUSP_BACKGROUND_WORKERS=0` in its ambient environment (the
 *    launch env, mirroring the request-only service drop-ins), which silently changes
 *    the ambient-env DEFAULT that `requestOnlyHost()` / `dbosLaunchesHere()`
 *    (background-workers.ts) resolve to for any call that doesn't pass an explicit env
 *    override — from "this process owns the substrate" to "request-only worker". Both
 *    predicates are DELIBERATELY vitest-guard-free (a test must be able to flip them via
 *    env, ambient or explicit), so unlike every var above there is no `VITEST` escape
 *    hatch inside the predicates themselves — the leak has to be scrubbed at the env
 *    layer, here. Found live 2026-07-19 (EI-2634 / this bug): 16/32
 *    in-process-status.test.ts tests + the sibling integration-smoke.test.ts failed
 *    DETERMINISTICALLY in every su/psu shell (bootedCount:0 / reachedSubstrateOwner:false
 *    instead of the healthy-with-handles result the test names describe) — not a flake,
 *    and invisible in CI (which never carries the var). Those two files had grown a local
 *    save/scrub/restore workaround for exactly this; centralizing it here makes it hold
 *    for every test file, not just the ones an agent happened to hand-patch. A test that
 *    genuinely wants the request-only-host branch still sets the var itself, in its own
 *    beforeEach/test body, which runs after this module-level scrub and so still wins.
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
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// A test must never make an unsolicited call to the public internet. mem0ai ships
// telemetry ON by default (`MEM0_TELEMETRY` is only disabled by the exact string
// 'false'), and `_Memory._autoInitialize` → `_initializeTelemetry` fires an 'init'
// event — a LIFECYCLE event, so it bypasses the 10% sample rate and runs on EVERY
// construction. `UnifiedTelemetry.captureEvent` POSTs to https://us.i.posthog.com
// and, when that fetch fails, swallows the error but logs `console.error(
// 'Telemetry event capture failed:', …)` — which vitest-fail-on-console promotes to
// a test failure. So any test that (transitively) builds a Memory reds whenever the
// box's egress is unhealthy: found 2026-08-13 (EI-20299393830613909), where
// work-items-urgent.test.ts failed 3× in 6h on ERR_SSL_WRONG_VERSION_NUMBER while
// passing on a re-run minutes later — a load/network-dependent red that is
// indistinguishable from a real regression and cannot be reproduced on demand.
// This is the same class as the voice-ipc redirect below (an orphaned-socket
// console.error redding local-audio-socket), and the fix belongs here for the same
// reason: two test files had each grown their own `process.env.MEM0_TELEMETRY =
// 'false'` line (memory/session-extraction-llm.test.ts, generic/memory
// extraction-llm.test.ts), which protects only the files an agent happened to
// hand-patch. Centralizing it makes it hold for every test file in every workspace.
// Those local lines are kept deliberately: a run through a bare vitest config that
// skips setupFiles (the known false-green trap, EI-14190) still gets them.
process.env.MEM0_TELEMETRY = 'false';

process.env.PAPERCUSP_PGBOUNCER = '0';
// Same rule as the voice-ipc redirect below — a unit test must never read the real
// ~/.papercusp. embedded-pg.json is the discovery file for a LIVE Postgres, so once the
// db resolver actually honors it (it silently did not: the writer emits `url`, the reader
// demanded `host` — see _parseDiscoveryJson in libs/papercusp/libs/db/src/connection.ts),
// an unguarded run on a machine with the desktop open would open pools against the
// developer's REAL database and mutate it. Pin discovery off for every test process.
// Against the pre-fix resolver this is a no-op: that reader never matched the file.
process.env.PAPERCUSP_SKIP_PG_DISCOVERY = '1';
if (!process.env.PAPERCUSP_VOICE_IPC_DIR) {
  const voiceIpcHermeticDir = mkdtempSync(join(tmpdir(), 'voice-ipc-hermetic-'));
  process.env.PAPERCUSP_VOICE_IPC_DIR = voiceIpcHermeticDir;
  // This module runs at the START of every vitest FILE fleet-wide (it's the
  // first entry in every defineVitestConfig's setupFiles) with no matching
  // teardown hook of its own — so the tmpdir it mints here was never removed.
  // At fleet scale that leaked 700k+ directories into the shared TMPDIR
  // (/tmp/pcv), degrading every mkdir/readdir/stat that touches it (including
  // the testcontainer start-lock under the same tree) and contributing to
  // spurious integration-test timeouts + elevated host load fleet-wide
  // (found + bulk-cleaned 2026-07-09, EI-8888-adjacent). `process.on('exit')`
  // is the right hook here (not vitest's globalTeardown, which only fires for
  // the pool's OWN root process, not each per-file worker that actually calls
  // this) — `rmSync` is safe to use in an 'exit' handler (sync-only context).
  process.on('exit', () => {
    try {
      rmSync(voiceIpcHermeticDir, { recursive: true, force: true });
    } catch {
      /* best-effort — never let cleanup fail the process */
    }
  });
}
delete process.env.PAPERCUSP_BACKGROUND_WORKERS;
delete process.env.PAPERCUSP_HONO_PORT;
delete process.env.PAPERCUSP_WORKSPACE_ID;
delete process.env.PAPERCUSP_POT_HOME_SLUG;
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
