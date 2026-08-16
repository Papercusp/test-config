/**
 * Regression guard for EI-18680404964770187: `getTestPg()` must never run
 * `container.exec(['psql', ...])` to apply the framework-role DDL again.
 *
 * Why this matters: `container.exec(...)` runs the command INSIDE the
 * container, where it is reparented to PID 1 — the postmaster in the
 * pgvector/pgvector:pg18 image. Postgres reaps UNKNOWN children in
 * HandleChildCrash/CleanupBackend, so an in-container psql that exits
 * nonzero (exactly the "in recovery mode" / "not yet accepting connections"
 * FATALs this file's retry loop rides out) is treated as a crashed backend —
 * the postmaster kills every active server process and forces a full
 * crash-recovery cycle (observed outage ~3min on the shared, fleet-reused
 * container). Worse, every retry attempt made WHILE recovering is itself
 * another in-container exec that can exit nonzero and re-trigger the same
 * crash, so the old retry loop fed the very fault it was trying to ride out
 * — amplifying under concurrent fleet load instead of damping it.
 *
 * The fix runs the DDL from a HOST-SIDE `postgres` client against the
 * container's published port (`container.getConnectionUri()`) instead — a
 * failed host-side connection is just a rejected promise; it can never be
 * reaped by the postmaster and can never restart the cluster.
 *
 * This is a plain (non-integration) source-text guard so it runs on every
 * `npm run test:affected`, not just when the integration suite touches
 * Docker — a regression here should fail fast, not wait for someone to hit
 * the crash again.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SOURCE = readFileSync(fileURLToPath(new URL('./pg-container.ts', import.meta.url)), 'utf8');

describe('getTestPg framework-role ensure (EI-18680404964770187)', () => {
  it('never runs psql (or any command) inside the shared container via container.exec', () => {
    // Strip comments (// and /* */) first — the fix's own doc comment names the
    // old `container.exec(['psql', ...])` pattern for explanation, which would
    // otherwise false-positive this guard. Only LIVE CODE must stay clean.
    const codeOnly = SOURCE
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    expect(codeOnly).not.toMatch(/container\.exec\s*\(/);
  });

  it('applies FRAMEWORK_ROLES_DDL via a host-side postgres client against getConnectionUri()', () => {
    // The retry loop must open a real `postgres` client against the
    // container's published TCP port, not an in-container exec.
    expect(SOURCE).toMatch(/postgres\(\s*container\.getConnectionUri\(\)/);
    expect(SOURCE).toMatch(/admin\.unsafe\(FRAMEWORK_ROLES_DDL\)/);
  });

  it('still retries on the transient startup FATALs the old exec-based loop rode out', () => {
    expect(SOURCE).toMatch(/in recovery mode/);
    expect(SOURCE).toMatch(/not yet accepting connections/);
  });
});

/**
 * Regression guard for EI-10533: the no-docker escape-hatch path
 * (`PAPERCUSP_TEST_PG_ADMIN_URL` — a bare `postgres` admin client against the
 * box's native PG, no Docker/testcontainers involved) previously had ZERO
 * retry tolerance for a transient "in recovery mode" / "not yet accepting
 * connections" FATAL, unlike the container path just above. A source-text
 * guard (not a mocked-execution test) because the retry behavior itself is
 * already covered by `withPgStartupRetry`'s own dedicated unit tests in
 * pg-reachability.test.ts — this only asserts getTestPg's no-docker branch
 * actually WIRES that shared helper in, so the two can't silently diverge
 * again.
 */
describe('getTestPg no-docker escape hatch (EI-10533)', () => {
  it('wraps the PAPERCUSP_TEST_PG_ADMIN_URL role-ensure in the shared startup-retry helper', () => {
    expect(SOURCE).toMatch(/import\s*\{\s*withPgStartupRetry\s*\}\s*from\s*'\.\/pg-reachability\.ts'/);
    // The withPgStartupRetry(...) call must appear strictly BEFORE the
    // container-path's own retry loop comment block, i.e. inside the
    // `existingAdminUrl` branch — not just imported and unused there.
    const noDockerBranchStart = SOURCE.indexOf('if (existingAdminUrl) {');
    const containerRetryLoopStart = SOURCE.indexOf('RETRY_BUDGET_MS');
    const withRetryCallIdx = SOURCE.indexOf('await withPgStartupRetry(');
    expect(noDockerBranchStart).toBeGreaterThan(-1);
    expect(containerRetryLoopStart).toBeGreaterThan(-1);
    expect(withRetryCallIdx).toBeGreaterThan(noDockerBranchStart);
    expect(withRetryCallIdx).toBeLessThan(containerRetryLoopStart);
  });

  it('names EI-10533 / shared-infra-churn in the wrapped error so the next agent debugs the right layer', () => {
    expect(SOURCE).toMatch(/no-docker escape hatch.*framework-role ensure/s);
    expect(SOURCE).toMatch(/shared-infra churn/);
    expect(SOURCE).toMatch(/EI-10533/);
  });
});
