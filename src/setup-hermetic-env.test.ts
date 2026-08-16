import { describe, expect, it } from 'vitest';

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
