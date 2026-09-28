/**
 * Setup file for the executed-inputs capture (P-009, gate-file-level-test-reuse-2026-09-27).
 * Wired by defineVitestConfig ONLY when the executed-source map is armed and
 * PC_EXECUTED_INPUTS_DIR names the hand-off directory. It runs before each test file (isolate),
 * starts a fresh recorder, and writes the file's inputs record from a setup-level afterAll, which
 * runs after the file's own afterAll hooks (hooks unwind as a stack).
 */
import * as childProcess from 'node:child_process';
import * as fs from 'node:fs';
import { writeFileSync } from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import * as net from 'node:net';
import * as workerThreads from 'node:worker_threads';
import { afterAll, expect } from 'vitest';
import { inferWorkspaceRoot } from './admin-test-runs-reporter';
import {
  PC_EXECUTED_INPUTS_DIR_ENV,
  beginFile,
  endFile,
  inputsFilePath,
  installCapture,
} from './executed-inputs-capture';

const dir = process.env[PC_EXECUTED_INPUTS_DIR_ENV]?.trim();
if (dir) {
  try {
    // `import * as` yields the ESM namespace (read-only); the CJS module objects are what
    // callers and syncBuiltinESMExports see, so patch those.
    const cjs = (ns: object) => ((ns as { default?: object }).default ?? ns) as Record<string, unknown>;
    installCapture(
      {
        fs: cjs(fs),
        fsPromises: cjs(fsPromises),
        childProcess: cjs(childProcess),
        workerThreads: cjs(workerThreads),
        netSocketPrototype: (cjs(net).Socket as { prototype: Record<string, unknown> } | undefined)?.prototype,
        syncBuiltinESMExports,
      },
      inferWorkspaceRoot(),
    );
    beginFile();
    // Vitest 4 hands a suite hook (context, suite) and PARSES the first parameter as a fixture
    // pattern: anything but an object pattern throws FixtureParseError ("received \"suite\"").
    // That failed every armed test file at teardown (green-checkpoint round 4 on eb3fa7fe,
    // 2026-09-28: 1,713 files). Guarded by setup-hook-signature.test.ts.
    // eslint-disable-next-line no-empty-pattern
    afterAll(({}, suite?: unknown) => {
      try {
        const filepath =
          (suite as { filepath?: string } | undefined)?.filepath ?? expect.getState().testPath ?? null;
        const record = endFile(filepath ?? '');
        if (filepath && record) writeFileSync(inputsFilePath(dir, filepath), JSON.stringify(record));
      } catch {
        /* no record = inputs unknown = never reused; never a test failure */
      }
    });
  } catch {
    /* capture unavailable: rows are recorded without inputs_captured and are never reused */
  }
}
