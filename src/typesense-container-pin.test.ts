import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { TEST_TYPESENSE_IMAGE } from './typesense-container.ts';

/**
 * Guards the resolution of EI-20467401893261300.
 *
 * The reported defect: this substrate's doc comment asserted it ran "the same
 * image the app runs in prod" and cited docker-compose.prod.yml, while the tag
 * was ALSO hand-written a second time in the GenericContainer call. Both halves
 * were wrong. The citation does not resolve in every consuming repo, and where
 * it does resolve it names a different major than the one pinned here — so the
 * parity claim was false, and the duplicated tag was free to drift from it.
 *
 * These tests read the source TEXT on purpose. A test that only asserted the
 * exported constant's value would restate the code and pass no matter how badly
 * the prose beside it drifted, which is the exact failure being fixed.
 */

/**
 * Subject path is overridable so falsifiability can be proven against a COPY
 * outside the repo, never by mutating this shared tree (a git-sync sweep would
 * happily commit the mutant mid-probe).
 *   TYPESENSE_PIN_SUBJECT=/tmp/mutant.ts npm run test:file -- <this file>
 */
const SOURCE_PATH =
  process.env.TYPESENSE_PIN_SUBJECT ?? new URL('./typesense-container.ts', import.meta.url);
const source = readFileSync(SOURCE_PATH, 'utf8');

/** Any `typesense/typesense:<tag>` occurrence, wherever it appears. */
const IMAGE_TAG_PATTERN = /typesense\/typesense:[\w.-]+/g;

describe('typesense test-substrate image pin (EI-20467401893261300)', () => {
  it('exposes the pin as an exported constant', () => {
    expect(TEST_TYPESENSE_IMAGE).toMatch(/^typesense\/typesense:[\w.-]+$/);
  });

  it('writes the image tag exactly once — a second copy is the drift vector', () => {
    const occurrences = source.match(IMAGE_TAG_PATTERN) ?? [];
    expect(
      occurrences,
      `The image tag must appear exactly once in typesense-container.ts (the ` +
        `TEST_TYPESENSE_IMAGE constant). Found ${occurrences.length}: ` +
        `${JSON.stringify(occurrences)}. Restating it in a comment or a second ` +
        `literal recreates the drift this guard exists to prevent.`,
    ).toHaveLength(1);

    // ...and the one occurrence must be the constant's own initializer.
    expect(source).toContain(`export const TEST_TYPESENSE_IMAGE = '${TEST_TYPESENSE_IMAGE}'`);
  });

  it('constructs the container from the constant, not a repeated literal', () => {
    expect(source).toContain('new GenericContainer(TEST_TYPESENSE_IMAGE)');
  });

  it('claims no parity with any consumer deployment file', () => {
    // The substrate is a shared submodule; consuming repos pin Typesense
    // differently, so no compose file can be cited as the parity authority.
    // `compose` is matched case-insensitively so a reworded citation still trips.
    expect(
      source,
      'typesense-container.ts must not cite a deployment/compose file as the ' +
        'authority for its pin — the citation is unresolvable in some consuming ' +
        'repos and contradicted in others (EI-20467401893261300).',
    ).not.toMatch(/docker-compose|compose\.ya?ml/i);
  });
});
