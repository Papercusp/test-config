import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { stateDirNeedsRedirect } from './hermetic-tmpdir.js';

/**
 * Guards the "no unsolicited outbound telemetry from a test process" invariant
 * that setup-hermetic-env.ts pins (EI-20299393830613909).
 *
 * This asserts the LIVE env of a real test process rather than grepping the
 * setup source, so it fails for either way the invariant can break: the line
 * being removed, OR the setup file stopping being wired into setupFiles.
 *
 * Falsifiability is established WITHOUT mutating the shared tree (the sweep race
 * in CLAUDE.md § "Proving a guard is falsifiable"): `readMem0TelemetryFlag` is a
 * faithful transcription of mem0ai's own gate, kept here permanently as a
 * control. The control cases prove the gate is real — an unset/misspelled value
 * leaves telemetry ON — and the calibration case proves the real process env is
 * the one value that turns it off. A guard that only asserted `=== 'false'`
 * would still pass if mem0ai's semantics changed; these cases pin the semantics.
 */

/**
 * mem0ai's telemetry gate, transcribed verbatim from
 * node_modules/mem0ai/dist/oss/index.mjs (`var MEM0_TELEMETRY = …`):
 * ONLY the exact string 'false' disables it. Everything else — unset, '0',
 * 'FALSE', 'no' — leaves telemetry ON.
 */
function readMem0TelemetryFlag(env: Record<string, string | undefined>): boolean {
  return env.MEM0_TELEMETRY === 'false' ? false : true;
}

describe('setup-hermetic-env: outbound telemetry is pinned off', () => {
  it('disables mem0ai telemetry in every test process', () => {
    // The real subject: this test file got the hermetic setup like any other.
    expect(process.env.MEM0_TELEMETRY).toBe('false');
    expect(readMem0TelemetryFlag(process.env)).toBe(false);
  });

  it('scrubs the live listener bind so route tests stay on the hermetic loopback policy', () => {
    // A spawned operator can export PAPERCUSP_BIND_HOST=0.0.0.0. Carrying that
    // production bind into a unit worker makes currentRemoteAuthPolicy throw
    // before auth handlers run unless the full remote-admin origin policy is
    // also present. The test default is loopback; remote-policy tests pass
    // explicit env objects or set the variable themselves.
    expect(process.env.PAPERCUSP_BIND_HOST).toBeUndefined();
  });

  // CONTROLS — deliberately-wrong values, kept permanently. If these ever pass
  // as "disabled", the gate transcription above has drifted from mem0ai and the
  // calibration case above is no longer proving anything.
  it.each([
    ['unset', undefined],
    ['0', '0'],
    ['FALSE', 'FALSE'],
    ['no', 'no'],
    ['true', 'true'],
  ])('leaves telemetry ENABLED for %s — only the exact string "false" disables it', (_label, value) => {
    expect(readMem0TelemetryFlag({ MEM0_TELEMETRY: value })).toBe(true);
  });
});

/** Re-run the setup module on an env carrying `values`, return those keys afterwards,
 *  then restore them. Used by every "the setup handles an inherited value" case below. */
async function runSetupOn(values: Record<string, string>): Promise<Record<string, string | undefined>> {
  const keys = Object.keys(values);
  const saved = new Map(keys.map((k) => [k, process.env[k]] as const));
  try {
    Object.assign(process.env, values);
    // vitest's resetModules clears every module except its own dist (setup files included),
    // so this import evaluates the setup module again and its module-level scrub re-runs.
    // The import must stay a static string: vite rewrites a template-literal import into a
    // glob helper that refuses the path ("Unknown variable dynamic import").
    vi.resetModules();
    await import('./setup-hermetic-env.js');
    return Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

/**
 * WI-10004341: a psu shell exports PAPERCUSP_OPERATOR_URL (+ its provenance marker), and
 * psu-launcher's resolveOperatorTarget reads that AMBIENT pin and console.warns when a
 * proxy answers — which fail-on-console turned into reds that depended on the invoking
 * shell. Asserting `process.env.PAPERCUSP_OPERATOR_URL === undefined` alone would pass
 * vacuously in any shell that never carried the pin, so this re-runs the setup module on
 * an env that DOES carry it and checks the result, whatever shell launched the test.
 */
describe('setup-hermetic-env: inherited live dependency-generation store is scrubbed', () => {
  it('removes the host store before release-shell fixtures select their private root', async () => {
    const after = await runSetupOn({
      PAPERCUSP_DEPENDENCY_GENERATION_ROOT: '/mnt/data/live-dependency-generations',
    });
    expect(after.PAPERCUSP_DEPENDENCY_GENERATION_ROOT).toBeUndefined();
  });

});

describe('setup-hermetic-env: inherited headless session ownership is scrubbed', () => {
  it('removes headless provenance before fixtures can reap their shared test scope', async () => {
    const after = await runSetupOn({ PAPERCUSP_PSU_HEADLESS: '1' });
    expect(after.PAPERCUSP_PSU_HEADLESS).toBeUndefined();
  });
});

describe('setup-hermetic-env: the psu operator pin is scrubbed (WI-10004341)', () => {
  it('removes a :3170 operator pin and its provenance marker', async () => {
    const after = await runSetupOn({
      PAPERCUSP_OPERATOR_URL: 'http://127.0.0.1:3170',
      PAPERCUSP_OPERATOR_URL_PROVENANCE: 'psu-launcher',
    });
    expect(after.PAPERCUSP_OPERATOR_URL).toBeUndefined();
    expect(after.PAPERCUSP_OPERATOR_URL_PROVENANCE).toBeUndefined();
  });

  // CALIBRATION — PORT is a long-standing scrub. If the re-run did not re-execute the
  // module, PORT would survive and the case above would be proving nothing.
  it('calibration: the re-run really executes the scrub (PORT is removed)', async () => {
    const after = await runSetupOn({ PORT: '3070' });
    expect(after.PORT).toBeUndefined();
  });

  // CONTROL — a variable the setup never lists must survive, so the cases above cannot
  // pass because the re-run wiped the whole environment.
  it('control: a variable outside the scrub list survives the re-run', async () => {
    const after = await runSetupOn({ PAPERCUSP_HERMETIC_ENV_CONTROL_UNLISTED: 'kept' });
    expect(after.PAPERCUSP_HERMETIC_ENV_CONTROL_UNLISTED).toBe('kept');
  });
});

describe('setup-hermetic-env: per-host spawner rollout is scrubbed', () => {
  it('removes inherited sidecar rollout controls so tests opt in explicitly', async () => {
    const after = await runSetupOn({
      PAPERCUSP_SPAWNER_SIDECAR: '1',
      PAPERCUSP_SPAWNER_SIDECAR_MODE: '1',
    });
    expect(after.PAPERCUSP_SPAWNER_SIDECAR).toBeUndefined();
    expect(after.PAPERCUSP_SPAWNER_SIDECAR_MODE).toBeUndefined();
  });
});

/**
 * WI-10004854: tests must never write managed-pty state (discovery records, sockets,
 * per-owner event logs, the sender inject audit) into the live ~/.papercusp/psu-pty.
 * Before this redirect, 193 itest event logs and 2 test sockets had accumulated
 * there from runs that bypassed apps/operator's integration-only shim.
 */
describe('setup-hermetic-env: the managed-pty state dir is redirected (WI-10004854)', () => {
  const liveDir = join(homedir(), '.papercusp', 'psu-pty');

  it('gives THIS test process a PAPERCUSP_PSU_PTY_DIR that is not the live dir', () => {
    // The real subject: fails if the redirect is removed OR the setup file stops being
    // wired into setupFiles (the env would then be unset, or the live inherited value).
    expect(process.env.PAPERCUSP_PSU_PTY_DIR).toBeTruthy();
    expect(stateDirNeedsRedirect(process.env.PAPERCUSP_PSU_PTY_DIR, liveDir)).toBe(false);
  });

  it('keeps managed native fixture control sockets within the Linux path limit', async () => {
    if (process.platform !== 'linux') return;
    const after = await runSetupOn({ PAPERCUSP_PSU_PTY_DIR: liveDir });
    // This owner came from the full-file run whose socket failed with EINVAL.
    const owner = 'su-port-negative-24878-missing-native-marker-106388';
    const socket = join(after.PAPERCUSP_PSU_PTY_DIR as string, `${owner}.sock`);
    expect(Buffer.byteLength(socket)).toBeLessThanOrEqual(107);
  });

  it('redirects an INHERITED value that is the live dir (a psu shell leaking its own env)', async () => {
    const after = await runSetupOn({ PAPERCUSP_PSU_PTY_DIR: liveDir });
    expect(after.PAPERCUSP_PSU_PTY_DIR).toBeTruthy();
    expect(resolve(after.PAPERCUSP_PSU_PTY_DIR as string)).not.toBe(liveDir);
    expect(after.PAPERCUSP_PSU_PTY_DIR?.startsWith(tmpdir())).toBe(true);
  });

  it('keeps a deliberate non-live override (an outer isolation shim or a probe)', async () => {
    const chosen = join(tmpdir(), `psu-pty-chosen-${process.pid}`);
    const after = await runSetupOn({ PAPERCUSP_PSU_PTY_DIR: chosen });
    expect(after.PAPERCUSP_PSU_PTY_DIR).toBe(chosen);
  });

  // CONTROLS for the redirect condition. If `stateDirNeedsRedirect` stopped resolving
  // paths, a trailing-slash spelling of the live dir would be honoured and the leak
  // would come back through it.
  it.each([
    ['unset', undefined, true],
    ['empty', '', true],
    ['the live dir', '/home/u/.papercusp/psu-pty', true],
    ['the live dir with a trailing slash', '/home/u/.papercusp/psu-pty/', true],
    ['the live dir spelled through ..', '/home/u/.papercusp/x/../psu-pty', true],
    ['a sibling dir', '/home/u/.papercusp/psu-pty-other', false],
    ['a tmp dir', '/tmp/pcv/papercusp-psu-pty-hermetic/1-abc', false],
  ])('stateDirNeedsRedirect: %s -> %s', (_label, inherited, expected) => {
    expect(stateDirNeedsRedirect(inherited, '/home/u/.papercusp/psu-pty')).toBe(expected);
  });
});
