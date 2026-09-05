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
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { NON_DESTRUCTIVE_PG_HEALTHCHECK } from "./pg-container.ts";
import { withContainerRecoveryReResolution } from "./pg-container.ts";

const SOURCE = readFileSync(
  fileURLToPath(new URL("./pg-container.ts", import.meta.url)),
  "utf8",
);
// These fixtures live in Papercusp's nested source checkout, which is not
// present in every consumer harness that vendors @papercusp/test-config.
// Keep the portable source guard below active everywhere, and inspect the
// nested fixtures whenever the owning checkout is available.
const HARNESS_ZERO_FIXTURE_SOURCES = [
  {
    name: "coord-links-blocks-notify",
    url: new URL(
      "../../papercusp/libs/db/src/coord-links-blocks-notify.integration.test.ts",
      import.meta.url,
    ),
  },
  {
    name: "workspace-host-tenant-rls-migration",
    url: new URL(
      "../../papercusp/libs/db/src/workspace-host-tenant-rls-migration.integration.test.ts",
      import.meta.url,
    ),
  },
  {
    name: "operator-core-org-test-db",
    url: new URL("../../../packages/operator-core/test/_org-test-db.ts", import.meta.url),
  },
].flatMap(({ name, url }) => {
  const path = fileURLToPath(url);
  return existsSync(path) ? [{ name, source: readFileSync(path, "utf8") }] : [];
});

function harnessZeroRoleDefinitions(source: string): string[] {
  return [...source.matchAll(/(?:CREATE|ALTER)\s+ROLE\s+harness_zero\b[^;]*;/g)].map(
    ([definition]) => definition,
  );
}

describe("getTestPg framework-role ensure (EI-18680404964770187)", () => {
  it("never runs psql (or any command) inside the shared container via container.exec", () => {
    // Strip comments (// and /* */) first — the fix's own doc comment names the
    // old `container.exec(['psql', ...])` pattern for explanation, which would
    // otherwise false-positive this guard. Only LIVE CODE must stay clean.
    const codeOnly = SOURCE.replace(/\/\*[\s\S]*?\*\//g, "").replace(
      /^\s*\/\/.*$/gm,
      "",
    );
    expect(codeOnly).not.toMatch(/container\.exec\s*\(/);
  });

  it("applies FRAMEWORK_ROLES_DDL via a host-side postgres client against getConnectionUri()", () => {
    // The retry loop must open a real `postgres` client against the
    // container's published TCP port, not an in-container exec.
    expect(SOURCE).toMatch(/postgres\(\s*container\.getConnectionUri\(\)/);
    expect(SOURCE).toMatch(/admin\.unsafe\(FRAMEWORK_ROLES_DDL\)/);
  });

  it("still retries on the transient startup FATALs the old exec-based loop rode out", () => {
    expect(SOURCE).toMatch(/in recovery mode/);
    expect(SOURCE).toMatch(/not yet accepting connections/);
    expect(SOURCE).toMatch(/RETRYABLE_PG_STARTUP_MSG\.test\(msg\)/);
  });
});

describe("getTestPg container healthcheck (EI-21116464706451765)", () => {
  it("never runs pg_isready inside the PID-1-postmaster container", () => {
    // The stock @testcontainers/postgresql healthcheck is destructive during
    // recovery: its nonzero child exit makes Postgres restart recovery again.
    // A harmless Docker liveness bit is sufficient because getTestPg performs
    // the authoritative SQL readiness probe from the host immediately after.
    //
    // Asserted against the EXPORTED CONSTANT rather than this file's source
    // text (EI-21340200136336953). The old form regexed SOURCE for an inline
    // `.withHealthCheck({ test: [...] })` object literal, which meant the guard
    // was coupled to one file's FORMATTING: hoisting the value into a shared
    // constant — the fix that lets sibling call sites stop drifting — broke the
    // guard, even though the shipped behaviour was unchanged and better.
    expect(NON_DESTRUCTIVE_PG_HEALTHCHECK.test).toEqual(["CMD-SHELL", "exit 0"]);
    expect(JSON.stringify(NON_DESTRUCTIVE_PG_HEALTHCHECK)).not.toContain(
      "pg_isready",
    );
    // and the container actually uses it, rather than re-inlining its own.
    expect(SOURCE).toMatch(
      /\.withHealthCheck\(\{\s*\.\.\.NON_DESTRUCTIVE_PG_HEALTHCHECK\s*\}\)/,
    );
  });

  it("keeps host-side SQL readiness after the non-destructive Docker healthcheck", () => {
    // The override REMOVES a startup gate: PostgreSqlContainer waits on
    // Wait.forAll([forHealthCheck(), forListeningPorts()]), so `exit 0` leaves
    // only "TCP port published" — which is not "Postgres accepts SQL". The
    // host-side probe is what makes the override safe, so it must come after.
    const healthcheckIdx = SOURCE.search(/\.withHealthCheck\(/);
    const hostProbeIdx = SOURCE.search(
      /postgres\(\s*container\.getConnectionUri\(\)/,
    );
    expect(healthcheckIdx).toBeGreaterThan(-1);
    expect(hostProbeIdx).toBeGreaterThan(healthcheckIdx);
    expect(SOURCE).toMatch(/admin\.unsafe\(FRAMEWORK_ROLES_DDL\)/);
  });
});

/**
 * EI-21340200136336953 — the CLASS-level guard, mirroring EI-9497.
 *
 * The constant above being correct is NOT enough, and the repo has already paid
 * to learn this once for the sibling PG-IMAGE constant: WI-2942 bumped the image
 * at ONE call site and four siblings kept a literal string, so those cycles
 * provisioned on the wrong PG major regardless of the constant's own test
 * passing (EI-9497). `gym-provision-image.test.ts` closed that by enumerating
 * every call site instead of pinning one file's text.
 *
 * The HEALTHCHECK never got that guard, and sat in exactly the pre-EI-9497
 * state: measured 2026-09-05, of 8 `new PostgreSqlContainer(...)` sites in this
 * repo, ONE set the non-destructive healthcheck and 7 took the stock destructive
 * one — two of those (`baseline-schema-global-setup.ts`, `gym/smoke.ts`) being
 * `.withReuse()`d and therefore long-lived BY DESIGN. `docker inspect` on the
 * live containers that day: 3 of 4 running pgvector containers carried the
 * retired `pg_isready` @250ms/1000-retries config, one of them created that
 * morning. So this was an incomplete rollout still MINTING destructive
 * containers, not merely historical drift.
 *
 * ALLOWLIST SEMANTICS — SHRINK-ONLY, like KNOWN_DARK_FLAGS and the inline-JSON
 * ratchet. Adopting the constant is not always safe: it removes a startup gate
 * and is only correct where the site performs a host-side SQL readiness wait
 * after `.start()`. Sites that lack one are listed here WITH THAT REASON rather
 * than converted blind, which would trade a rare crash-recovery bug for a common
 * startup race. Convert a site, then DELETE its entry. Never add one to make a
 * new call site pass.
 */
const HEALTHCHECK_EXEMPT: Record<string, string> = {
  // Gym runtime cycles: each goes straight from `.start()` to provisioning /
  // querying with no host-side readiness retry, so the override is not yet safe
  // here. Converting these means ALSO giving them a readiness wait.
  "packages/operator-core/lib/gym/ab-run.ts": "no host-side readiness probe",
  "packages/operator-core/lib/gym/autoloop-cycle.ts": "no host-side readiness probe",
  "packages/operator-core/lib/gym/blueprint-cycle.ts": "no host-side readiness probe",
  "packages/operator-core/lib/gym/smoke.ts":
    "no host-side readiness probe (and .withReuse() — convert first)",
  "packages/operator-core/lib/gym/wake-mode.ts": "no host-side readiness probe",
  // One-shot CLI verifier; ephemeral container, not reused across runs.
  "packages/operator-core/lib/db-tools/verify-baseline.ts":
    "ephemeral one-shot container, not reused",
};

/**
 * The offender rule, as a PURE function of (call sites, source reader, allowlist)
 * so it can be exercised against deliberately-wrong inputs.
 *
 * Extracted deliberately: a guard that has never failed is a guard nobody has
 * tested, and the honest way to prove THIS one fires is a permanent control
 * (see the describe below), not a temporary mutation of the shared checkout —
 * git-sync sweeps the whole tree on a schedule, so a probe that edits a tracked
 * file can have its mutant committed even when nothing goes wrong.
 */
export function findHealthcheckOffenders(
  files: string[],
  readSource: (file: string) => string,
  exempt: Record<string, string>,
): string[] {
  const offenders: string[] = [];
  for (const file of files) {
    if (file in exempt) continue;
    if (!readSource(file).includes("NON_DESTRUCTIVE_PG_HEALTHCHECK")) {
      offenders.push(file);
    }
  }
  return offenders;
}

describe("PostgreSqlContainer healthcheck rollout (EI-21340200136336953)", () => {
  const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

  /**
   * Every non-node_modules .ts file constructing a PostgreSqlContainer.
   *
   * `grep -rl` (one line per FILE) deliberately, not `-rn` piped through a line
   * cap: this list drives a NEGATIVE conclusion ("no unguarded site exists"),
   * and a positional truncation is exactly what manufactures a false clean here.
   * A no-match grep exits 1, which would throw out of execFileSync as an opaque
   * error — caught and returned as [] so the vacuity guard below reports it as
   * the broken walk it is, rather than an unreadable stack.
   */
  function containerCallSites(): string[] {
    let out = "";
    try {
      out = execFileSync(
        "grep",
        [
          "-rl",
          "--include=*.ts",
          "--exclude-dir=node_modules",
          "--exclude-dir=.git",
          "new PostgreSqlContainer",
          ".",
        ],
        { cwd: REPO_ROOT, encoding: "utf8" },
      );
    } catch {
      return [];
    }
    return out
      .split("\n")
      .map((l) => l.trim().replace(/^\.\//, ""))
      .filter((l) => l.length > 0 && !l.endsWith(".test.ts"))
      .sort();
  }

  it("discovers the call sites at all (guards a broken discovery walk)", () => {
    // A discovery guard whose walk silently matches nothing passes vacuously and
    // is indistinguishable from a clean repo — the failure mode this whole file
    // exists to prevent, one level up.
    expect(containerCallSites().length).toBeGreaterThan(1);
  });

  it("every call site uses NON_DESTRUCTIVE_PG_HEALTHCHECK, or is allowlisted with a reason", () => {
    const offenders = findHealthcheckOffenders(
      containerCallSites(),
      (f) => readFileSync(join(REPO_ROOT, f), "utf8"),
      HEALTHCHECK_EXEMPT,
    );
    expect(
      offenders,
      `these files construct a PostgreSqlContainer without the shared ` +
        `NON_DESTRUCTIVE_PG_HEALTHCHECK, so they take @testcontainers/postgresql's ` +
        `stock pg_isready healthcheck — destructive during crash recovery ` +
        `(EI-21116464706451765). Import the constant from @papercusp/test-config ` +
        `AND give the site a host-side SQL readiness wait after .start(); the ` +
        `healthcheck override removes a startup gate and is unsafe without one. ` +
        `If it genuinely cannot adopt it, add it to HEALTHCHECK_EXEMPT with a reason.`,
    ).toEqual([]);
  });

  /**
   * FALSIFIABILITY CONTROLS — permanent, in-file, zero tree mutation.
   *
   * The three cases above all currently PASS, and a guard whose walk silently
   * matched nothing would pass identically. These fix that: the first proves the
   * rule FIRES on an unguarded site, and the other two are the controls that must
   * SURVIVE it — without them, a rule that simply flagged everything (or nothing)
   * would look just as green.
   */
  const FIXTURE = {
    "fake/unguarded.ts": "new PostgreSqlContainer(IMG).withReuse().start()",
    "fake/guarded.ts":
      "new PostgreSqlContainer(IMG).withHealthCheck({ ...NON_DESTRUCTIVE_PG_HEALTHCHECK })",
    "fake/allowlisted.ts": "new PostgreSqlContainer(IMG).start()",
  } as const;
  const readFixture = (f: string) => FIXTURE[f as keyof typeof FIXTURE] ?? "";

  it("CONTROL: reports a call site that omits the shared healthcheck", () => {
    expect(
      findHealthcheckOffenders(["fake/unguarded.ts"], readFixture, {}),
    ).toEqual(["fake/unguarded.ts"]);
  });

  it("CONTROL: does NOT report a site that uses the constant, nor an allowlisted one", () => {
    expect(
      findHealthcheckOffenders(Object.keys(FIXTURE), readFixture, {
        "fake/allowlisted.ts": "control: exempt with a reason",
      }),
    ).toEqual(["fake/unguarded.ts"]);
  });

  it("the allowlist is shrink-only: every entry still exists and still needs the exemption", () => {
    // A stale entry silently re-permits a site that has since been converted (or
    // deleted), which is how a shrink-only list quietly stops shrinking.
    const sites = new Set(containerCallSites());
    const stale = Object.keys(HEALTHCHECK_EXEMPT).filter((f) => {
      if (!sites.has(f)) return true;
      return readFileSync(join(REPO_ROOT, f), "utf8").includes(
        "NON_DESTRUCTIVE_PG_HEALTHCHECK",
      );
    });
    expect(
      stale,
      "these HEALTHCHECK_EXEMPT entries are stale — the file no longer " +
        "constructs a PostgreSqlContainer, or it now uses the shared constant. " +
        "Delete them; the allowlist only ever shrinks.",
    ).toEqual([]);
  });
});

describe("harness_zero test-role boundary (EI-21638847910599943)", () => {
  it("normalizes both new and pre-existing roles to the sync-role privilege boundary", () => {
    const definitions = harnessZeroRoleDefinitions(SOURCE);

    expect(definitions).toHaveLength(2);
    for (const definition of definitions) {
      expect(definition).toMatch(/\bLOGIN\b/);
      expect(definition).toMatch(/\bREPLICATION\b/);
      expect(definition).toMatch(/\bNOSUPERUSER\b/);
      expect(definition).toMatch(/\bBYPASSRLS\b/);
      expect(definition).not.toMatch(/\bSUPERUSER\b/);
    }
  });

  it.skipIf(HARNESS_ZERO_FIXTURE_SOURCES.length === 0)(
    "keeps each fixture's fallback role definition inside that same boundary",
    () => {
    for (const fixture of HARNESS_ZERO_FIXTURE_SOURCES) {
      const definitions = harnessZeroRoleDefinitions(fixture.source);

      expect(definitions, fixture.name).not.toHaveLength(0);
      for (const definition of definitions) {
        expect(definition, fixture.name).toMatch(/\bLOGIN\b/);
        expect(definition, fixture.name).toMatch(/\bREPLICATION\b/);
        expect(definition, fixture.name).toMatch(/\bNOSUPERUSER\b/);
        expect(definition, fixture.name).toMatch(/\bBYPASSRLS\b/);
        expect(definition, fixture.name).not.toMatch(/\bSUPERUSER\b/);
      }
    }
    },
  );
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
describe("getTestPg no-docker escape hatch (EI-10533)", () => {
  it("wraps the PAPERCUSP_TEST_PG_ADMIN_URL role-ensure in the shared startup-retry helper", () => {
    expect(SOURCE).toMatch(
      /import\s*\{[\s\S]*withPgStartupRetry[\s\S]*\}\s*from\s*["']\.\/pg-reachability\.ts["']/,
    );
    // The withPgStartupRetry(...) call must appear strictly BEFORE the
    // container-path's own retry loop comment block, i.e. inside the
    // `existingAdminUrl` branch — not just imported and unused there.
    const noDockerBranchStart = SOURCE.indexOf("if (existingAdminUrl) {");
    const containerRetryLoopStart = SOURCE.indexOf("RETRY_BUDGET_MS");
    const withRetryCallIdx = SOURCE.indexOf("await withPgStartupRetry(");
    expect(noDockerBranchStart).toBeGreaterThan(-1);
    expect(containerRetryLoopStart).toBeGreaterThan(-1);
    expect(withRetryCallIdx).toBeGreaterThan(noDockerBranchStart);
    expect(withRetryCallIdx).toBeLessThan(containerRetryLoopStart);
  });

  it("names EI-10533 / shared-infra-churn in the wrapped error so the next agent debugs the right layer", () => {
    expect(SOURCE).toMatch(/no-docker escape hatch.*framework-role ensure/s);
    expect(SOURCE).toMatch(/shared-infra churn/);
    expect(SOURCE).toMatch(/EI-10533/);
  });
});

describe("getTestPg acquisition failure framing (EI-21904002928882606)", () => {
  it("rethrows the breaker diagnosis before the persistent-outage latch trips", () => {
    expect(SOURCE).toMatch(
      /throw\s+substrateBreaker\.recordFailure\(e\)\s*;/,
    );
  });
});

describe("withContainerRecoveryReResolution", () => {
  it("retires a retryable failed candidate and resolves a fresh one", async () => {
    const resolved = ["wedged", "fresh"];
    const ensured: string[] = [];
    const retired: string[] = [];

    const result = await withContainerRecoveryReResolution(
      async () => resolved.shift()!,
      async (container) => {
        ensured.push(container);
        if (container === "wedged")
          throw new Error("FATAL: the database system is in recovery mode");
      },
      async (container) => {
        retired.push(container);
      },
    );

    expect(result).toBe("fresh");
    expect(ensured).toEqual(["wedged", "fresh"]);
    expect(retired).toEqual(["wedged"]);
  });

  it("does not retire or re-resolve a non-retryable ensure failure", async () => {
    let resolveCount = 0;
    const retired: string[] = [];

    await expect(
      withContainerRecoveryReResolution(
        async () => {
          resolveCount += 1;
          return "candidate";
        },
        async () => {
          throw new Error("password authentication failed");
        },
        async (container) => {
          retired.push(container);
        },
      ),
    ).rejects.toThrow("password authentication failed");

    expect(resolveCount).toBe(1);
    expect(retired).toEqual([]);
  });

  it("honors the maximum number of resolutions", async () => {
    let resolveCount = 0;
    let retireCount = 0;

    await expect(
      withContainerRecoveryReResolution(
        async () => {
          resolveCount += 1;
          return `candidate-${resolveCount}`;
        },
        async () => {
          throw new Error("ECONNREFUSED: database connection refused");
        },
        async () => {
          retireCount += 1;
        },
        { maxResolutions: 2 },
      ),
    ).rejects.toThrow("ECONNREFUSED");

    expect(resolveCount).toBe(2);
    expect(retireCount).toBe(1);
  });

  it("rejects a non-positive resolution limit before resolving", async () => {
    let resolveCount = 0;

    await expect(
      withContainerRecoveryReResolution(
        async () => {
          resolveCount += 1;
          return "candidate";
        },
        async () => {},
        async () => {},
        { maxResolutions: 0 },
      ),
    ).rejects.toThrow("maxResolutions must be a positive integer");

    expect(resolveCount).toBe(0);
  });
});

describe("getTestPg reused-container recovery re-resolution", () => {
  it("serializes start, readiness ensure, retirement, and re-resolution", () => {
    expect(SOURCE).toMatch(
      /withTestcontainerStartLock\(\s*['"]shared-docker-testcontainers-start['"][\s\S]*withContainerRecoveryReResolution\(/,
    );
    expect(SOURCE).toMatch(
      /withContainerRecoveryReResolution\([\s\S]*async \(container\) => \{/,
    );
    expect(SOURCE).toMatch(/await container\.stop\(\)/);
  });
});
