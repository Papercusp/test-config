/**
 * UNIT-LAYER ONLY — forbids a real Postgres connection (EI-19311807188719573).
 *
 * The sibling of `setup-hermetic-env.ts`'s "a unit test must never read/write the real
 * ~/.papercusp" rule, applied to the database. That file already pins
 * `PAPERCUSP_SKIP_PG_DISCOVERY=1` so a test cannot find the developer's live DB via the
 * discovery file — but discovery is only ONE of four ways a URL resolves
 * (HARNESS_ADMIN_DATABASE_URL, DATABASE_URL, the discovery file, the native fallback),
 * so a unit test could still open a real pool through any of the other three. It did:
 * that is how the premise-probes gate red happened (a leg escaped `vi.mock`, read the
 * live WI-6560 row, and stayed green until that row was closed).
 *
 * This closes the remaining three by guarding the CONSEQUENCE at `buildClient`, the one
 * choke point every real pool passes through, instead of the cause. Deliberately so:
 * the causal shape (an un-memoized dynamic `import()` inside a concurrently-called
 * function) appears at many sites and is hazardous only at the concurrently-called
 * ones, which no grep can distinguish — a lint for it would have to ship advisory with
 * a baseline nobody reads. "A unit test is holding a real PG handle" is one unambiguous
 * bit, needs no baseline, and catches instances whose causal shape nobody has imagined.
 *
 * NOT applied to the integration layer, which legitimately builds real clients against
 * a throwaway testcontainer. A unit test that genuinely needs a live pool can delete the
 * var in its own beforeAll/test body — that runs AFTER this module-level set and so
 * still wins, exactly like the PAPERCUSP_PGBOUNCER / PAPERCUSP_SKIP_PG_DISCOVERY
 * precedents. Prefer renaming such a file to `*.integration.test.ts`.
 */
process.env.PAPERCUSP_FORBID_REAL_PG = '1';
