import { describe, expect, it, vi } from 'vitest';

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

/**
 * WI-10004341: a psu shell exports PAPERCUSP_OPERATOR_URL (+ its provenance marker), and
 * psu-launcher's resolveOperatorTarget reads that AMBIENT pin and console.warns when a
 * proxy answers — which fail-on-console turned into reds that depended on the invoking
 * shell. Asserting `process.env.PAPERCUSP_OPERATOR_URL === undefined` alone would pass
 * vacuously in any shell that never carried the pin, so this re-runs the setup module on
 * an env that DOES carry it and checks the result, whatever shell launched the test.
 */
describe('setup-hermetic-env: the psu operator pin is scrubbed (WI-10004341)', () => {
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
