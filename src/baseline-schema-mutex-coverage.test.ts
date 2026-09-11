/**
 * baseline-schema-mutex-coverage.test.ts — recurrence guard for the
 * expensive-fixture isolation hole (plan review-verification-efficiency-2026-09-09,
 * R-8 "improve expensive fixture isolation").
 *
 * THE SHARED RESOURCE: `baseline-schema-global-setup.ts` stands up ONE Postgres
 * container that is `.withReuse()`d by every concurrent Vitest process on the box —
 * apps/operator and packages/operator-core point at the SAME globalSetup, so their
 * integration files run against the SAME database, in parallel, in different
 * processes.
 *
 * THE EXISTING ISOLATION MECHANISM: `_baseline-coord-fixture.ts` serializes its
 * consumers on a Postgres session advisory lock (EI-18683737202696167). That fixed
 * the observed cross-file row leakage — but the lock is a property of ONE FIXTURE
 * MODULE, while the thing it protects (global `harness_shared` tables in a shared
 * container) has consumers that never go through that fixture. A consumer outside
 * the fixture is excluded by nothing.
 *
 * WHY THAT IS A REAL DEFECT AND NOT A STYLE POINT: several fixture consumers wipe
 * shared tables UNQUALIFIED (`TRUNCATE harness_shared.adv_sessions`, no WHERE).
 * An unqualified wipe destroys EVERY concurrent consumer's rows, not just its own.
 * It is safe only if every other consumer of that table holds the same lock — which
 * is exactly the invariant asserted below. Scoping discipline elsewhere does not
 * help: a `DELETE ... WHERE workspace_id = $ws` seed is still annihilated by
 * somebody else's bare TRUNCATE of the same table.
 *
 * THE INVARIANT (minimal, not blanket): for any shared table that at least one
 * baseline-container consumer wipes UNQUALIFIED, every baseline-container consumer
 * that mutates that table must hold the baseline-schema mutex. A table nobody wipes
 * globally may still be mutated scoped without the lock — this guard does not
 * demand a lock where there is no global wipe to be protected from.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { resolveRepoFile } from './repo-file.ts';

const MARKER = 'libs/test-config/src/baseline-schema-global-setup.ts';
const HERE = dirname(fileURLToPath(import.meta.url));
/** Repo root = the marker's resolved absolute path minus the marker's own relative path. */
const REPO_ROOT = resolveRepoFile(HERE, MARKER).slice(0, -(MARKER.length + 1));

/** Roots that can hold an integration test reaching the shared container. */
const SCAN_ROOTS = ['apps', 'libs', 'packages'];
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'coverage', '.git', '.vitest-tmp', 'target']);

/** A file reaches the expensive shared container if it injects the DSN or uses the coord fixture. */
const REACHES_CONTAINER = /baselineSchemaDsn|setupBaselineCoordFixture/;

/** A file holds the isolation lock via the fixture, or via the shared mutex helper. */
const HOLDS_MUTEX = /setupBaselineCoordFixture|acquireBaselineSchemaMutex|withBaselineSchemaMutex/;

/** TRUNCATE / DELETE FROM against a harness_shared table, with a bounded tail to spot a WHERE. */
const MUTATION = /(TRUNCATE(?:\s+TABLE)?|DELETE\s+FROM)\s+harness_shared\.([a-z_]+)([\s\S]{0,200}?)(?:`|;)/gi;

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) walk(full, out);
    else if (name.endsWith('.ts')) out.push(full);
  }
  return out;
}

interface Mutation {
  file: string;
  table: string;
  unqualified: boolean;
  holdsMutex: boolean;
}

function scan(): { consumers: string[]; mutations: Mutation[] } {
  const consumers: string[] = [];
  const mutations: Mutation[] = [];
  for (const root of SCAN_ROOTS) {
    for (const full of walk(join(REPO_ROOT, root))) {
      let src: string;
      try {
        src = readFileSync(full, 'utf8');
      } catch {
        continue;
      }
      if (!REACHES_CONTAINER.test(src)) continue;
      const rel = relative(REPO_ROOT, full);
      consumers.push(rel);
      const holdsMutex = HOLDS_MUTEX.test(src);
      for (const m of src.matchAll(MUTATION)) {
        const [, , table, tail] = m;
        mutations.push({ file: rel, table, unqualified: !/\bWHERE\b/i.test(tail), holdsMutex });
      }
    }
  }
  return { consumers, mutations };
}

describe('baseline-schema shared-container isolation (R-8 expensive fixture isolation)', () => {
  const { consumers, mutations } = scan();

  // ---- Positive controls -------------------------------------------------
  // A scan that silently stops finding files would make every assertion below
  // pass vacuously, which is indistinguishable from "the repo is clean". These
  // fail loudly instead. (Same false-zero family as a `| head`-truncated grep.)
  it('positive control: the scan actually finds the shared-container consumers', () => {
    expect(consumers.length).toBeGreaterThanOrEqual(20);
    expect(mutations.length).toBeGreaterThanOrEqual(50);
  });

  it('positive control: at least one shared table really is wiped UNQUALIFIED', () => {
    // If this ever goes to zero the hazard class is gone and the guard below is
    // vacuous — that is a real change worth failing on, not a silent pass.
    expect(mutations.filter((m) => m.unqualified).length).toBeGreaterThan(0);
  });

  // ---- The invariant -----------------------------------------------------
  it('every consumer of a globally-wiped shared table holds the baseline-schema mutex', () => {
    const globallyWiped = new Set(mutations.filter((m) => m.unqualified).map((m) => m.table));

    const violations = mutations
      .filter((m) => globallyWiped.has(m.table) && !m.holdsMutex)
      .map((m) => `${m.file} mutates harness_shared.${m.table} (globally wiped elsewhere) WITHOUT the mutex`);

    expect([...new Set(violations)].sort()).toEqual([]);
  });
});
