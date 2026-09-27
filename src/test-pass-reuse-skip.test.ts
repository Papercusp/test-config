import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  PC_TEST_REUSE_SKIP_LIST_ENV,
  REUSE_SKIP_LIST_SCHEMA,
  escapeGlobLiteral,
  executedSourceRunContext,
  executedSourceRunnerIdentity,
  resolveReuseSkipExclude,
} from './test-pass-reuse-skip';

// gate-file-level-test-reuse-2026-09-27 P-008: the vitest side of per-file pass reuse. Every
// failure mode must run MORE tests (return no exclude entries), never fewer.

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function listFile(body: unknown): string {
  const d = mkdtempSync(join(tmpdir(), 'reuse-skip-reader-'));
  dirs.push(d);
  const p = join(d, 'list.json');
  writeFileSync(p, typeof body === 'string' ? body : JSON.stringify(body));
  return p;
}

const here = () => ({
  schema: REUSE_SKIP_LIST_SCHEMA,
  runContext: executedSourceRunContext({}),
  runnerIdentity: executedSourceRunnerIdentity(),
  judgedSha: 'c58655490ce1a3be',
});

describe('resolveReuseSkipExclude', () => {
  const logs: string[] = [];
  const log = (l: string) => logs.push(l);
  afterEach(() => logs.splice(0));

  it('is inert when the channel is not in use', () => {
    expect(resolveReuseSkipExclude({}, log)).toEqual([]);
    expect(logs).toEqual([]);
  });

  it('excludes the listed files, escaped, when context and identity match', () => {
    const env = { [PC_TEST_REUSE_SKIP_LIST_ENV]: listFile({ ...here(), files: ['lib/b.test.ts', 'app/(g)/[id].test.ts'] }) };
    expect(resolveReuseSkipExclude(env, log)).toEqual(['app/\\(g\\)/\\[id\\].test.ts', 'lib/b.test.ts']);
    expect(logs[0]).toMatch(/\[test-pass-reuse\] skipping 2 file\(s\)/);
  });

  it('runs every file for an unreadable, malformed, foreign-context or foreign-runner list', () => {
    const cases = [
      join(tmpdir(), 'definitely-missing-reuse-skip-list.json'),
      listFile('not json'),
      listFile({ ...here(), schema: 99, files: ['a.test.ts'] }),
      listFile({ ...here(), runContext: 'green-checkpoint', files: ['a.test.ts'] }),
      listFile({ ...here(), runnerIdentity: 'v0.0.0 plan9 mips', files: ['a.test.ts'] }),
    ];
    for (const p of cases) {
      // runContext for an env WITHOUT GREEN_CHECKPOINT is clean-local, so a green-checkpoint list is foreign.
      expect(resolveReuseSkipExclude({ [PC_TEST_REUSE_SKIP_LIST_ENV]: p }, log)).toEqual([]);
    }
    expect(logs.filter((l) => /UNREADABLE|DECLINED/.test(l))).toHaveLength(cases.length);
  });

  it('escapes every glob metacharacter and nothing else', () => {
    expect(escapeGlobLiteral('a/b-c_d.e.test.ts')).toBe('a/b-c_d.e.test.ts');
    expect(escapeGlobLiteral('x*?[]{}()!+@\\y')).toBe('x\\*\\?\\[\\]\\{\\}\\(\\)\\!\\+\\@\\\\y');
  });

  it('stamps the run context from GREEN_CHECKPOINT', () => {
    expect(executedSourceRunContext({ GREEN_CHECKPOINT: '1' })).toBe('green-checkpoint');
    expect(executedSourceRunContext({})).toBe('clean-local');
  });
});
