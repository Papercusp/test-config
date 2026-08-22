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
import { withContainerRecoveryReResolution } from './pg-container.ts';

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

describe('getTestPg container healthcheck (EI-21116464706451765)', () => {
  it('never runs pg_isready inside the PID-1-postmaster container', () => {
    // The stock @testcontainers/postgresql healthcheck is destructive during
    // recovery: its nonzero child exit makes Postgres restart recovery again.
    // A harmless Docker liveness bit is sufficient because getTestPg performs
    // the authoritative SQL readiness probe from the host immediately after.
    expect(SOURCE).toMatch(/\.withHealthCheck\(\{[\s\S]*?test:\s*\['CMD-SHELL',\s*'exit 0'\]/);
    const healthcheckBlock = SOURCE.match(/\.withHealthCheck\(\{[\s\S]*?\}\)/)?.[0] ?? '';
    expect(healthcheckBlock).not.toContain('pg_isready');
  });

  it('keeps host-side SQL readiness after the non-destructive Docker healthcheck', () => {
    const healthcheckIdx = SOURCE.indexOf("test: ['CMD-SHELL', 'exit 0']");
    const hostProbeIdx = SOURCE.indexOf('postgres(container.getConnectionUri()');
    expect(healthcheckIdx).toBeGreaterThan(-1);
    expect(hostProbeIdx).toBeGreaterThan(healthcheckIdx);
    expect(SOURCE).toMatch(/admin\.unsafe\(FRAMEWORK_ROLES_DDL\)/);
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

describe('withContainerRecoveryReResolution', () => {
  it('retires a retryable failed candidate and resolves a fresh one', async () => {
    const resolved = ['wedged', 'fresh'];
    const ensured: string[] = [];
    const retired: string[] = [];

    const result = await withContainerRecoveryReResolution(
      async () => resolved.shift()!,
      async (container) => {
        ensured.push(container);
        if (container === 'wedged') throw new Error('FATAL: the database system is in recovery mode');
      },
      async (container) => {
        retired.push(container);
      },
    );

    expect(result).toBe('fresh');
    expect(ensured).toEqual(['wedged', 'fresh']);
    expect(retired).toEqual(['wedged']);
  });

  it('does not retire or re-resolve a non-retryable ensure failure', async () => {
    let resolveCount = 0;
    const retired: string[] = [];

    await expect(
      withContainerRecoveryReResolution(
        async () => {
          resolveCount += 1;
          return 'candidate';
        },
        async () => {
          throw new Error('password authentication failed');
        },
        async (container) => {
          retired.push(container);
        },
      ),
    ).rejects.toThrow('password authentication failed');

    expect(resolveCount).toBe(1);
    expect(retired).toEqual([]);
  });

  it('honors the maximum number of resolutions', async () => {
    let resolveCount = 0;
    let retireCount = 0;

    await expect(
      withContainerRecoveryReResolution(
        async () => {
          resolveCount += 1;
          return `candidate-${resolveCount}`;
        },
        async () => {
          throw new Error('ECONNREFUSED: database connection refused');
        },
        async () => {
          retireCount += 1;
        },
        { maxResolutions: 2 },
      ),
    ).rejects.toThrow('ECONNREFUSED');

    expect(resolveCount).toBe(2);
    expect(retireCount).toBe(1);
  });

  it('rejects a non-positive resolution limit before resolving', async () => {
    let resolveCount = 0;

    await expect(
      withContainerRecoveryReResolution(
        async () => {
          resolveCount += 1;
          return 'candidate';
        },
        async () => {},
        async () => {},
        { maxResolutions: 0 },
      ),
    ).rejects.toThrow('maxResolutions must be a positive integer');

    expect(resolveCount).toBe(0);
  });
});

describe('getTestPg reused-container recovery re-resolution', () => {
  it('serializes start, readiness ensure, retirement, and re-resolution', () => {
    expect(SOURCE).toMatch(
      /withTestcontainerStartLock\(\s*['"]shared-docker-testcontainers-start['"][\s\S]*withContainerRecoveryReResolution\(/,
    );
    expect(SOURCE).toMatch(/withContainerRecoveryReResolution\([\s\S]*async \(container\) => \{/);
    expect(SOURCE).toMatch(/await container\.stop\(\)/);
  });
});
