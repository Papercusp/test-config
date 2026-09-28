/**
 * Setup files registered through defineVitestConfig run inside EVERY test file of a lane, so
 * a malformed suite hook in one of them fails the whole lane at once.
 *
 * Vitest 4 hands a suite hook `(context, suite)` and parses the FIRST parameter as a fixture
 * pattern (@vitest/runner getUsedProps). Anything other than an object pattern throws
 * FixtureParseError: "The 1st argument inside a fixture must use object destructuring
 * pattern ... received \"suite\"". executed-inputs-capture-setup.ts registered
 * `afterAll((suite?: unknown) => …)`, and the first gate run that armed the capture
 * (green-checkpoint round 4 on eb3fa7fe, 2026-09-28) failed 1,713 files with that error.
 *
 * This applies Vitest's own rule to every suite hook registered by a setup file here.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const SRC = __dirname;
const SUITE_HOOKS = new Set(['beforeAll', 'afterAll', 'beforeEach', 'afterEach']);

type HookSite = { file: string; hook: string; line: number; firstParam: string | null };

/** Every suite-hook callback in `source`, with the text of its first parameter. */
export function suiteHookSites(file: string, source: string): HookSite[] {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const sites: HookSite[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && SUITE_HOOKS.has(node.expression.text)) {
      const cb = node.arguments[0];
      if (cb && (ts.isArrowFunction(cb) || ts.isFunctionExpression(cb))) {
        const first = cb.parameters[0];
        sites.push({
          file,
          hook: node.expression.text,
          line: sf.getLineAndCharacterOfPosition(node.getStart()).line + 1,
          firstParam: first ? first.name.getText(sf) : null,
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return sites;
}

/** Vitest's rule: a present first parameter must be an object pattern. */
export function violatesFixtureRule(site: HookSite): boolean {
  return site.firstParam !== null && !site.firstParam.startsWith('{');
}

const setupFiles = readdirSync(SRC).filter((f) => /-setup\.ts$/.test(f));

describe('setup-file suite hooks satisfy Vitest 4 fixture parsing', () => {
  it('finds the setup files it is meant to police (the scan is not vacuous)', () => {
    expect(setupFiles).toContain('executed-inputs-capture-setup.ts');
    const sites = setupFiles.flatMap((f) => suiteHookSites(f, readFileSync(join(SRC, f), 'utf8')));
    expect(sites.some((s) => s.file === 'executed-inputs-capture-setup.ts' && s.hook === 'afterAll')).toBe(true);
  });

  it('no setup file registers a suite hook whose first parameter is not an object pattern', () => {
    const bad = setupFiles
      .flatMap((f) => suiteHookSites(f, readFileSync(join(SRC, f), 'utf8')))
      .filter(violatesFixtureRule)
      .map((s) => `${s.file}:${s.line} ${s.hook}((${s.firstParam}) => …)`);
    expect(bad).toEqual([]);
  });

  it('the detector flags the exact shape that broke the gate and accepts the fixed shapes', () => {
    const src = [
      "afterAll((suite?: unknown) => {});",
      "afterAll(({}, suite?: unknown) => {});",
      "afterAll(() => {});",
      "beforeAll(async function (s) {});",
    ].join('\n');
    const verdicts = suiteHookSites('probe.ts', src).map(violatesFixtureRule);
    expect(verdicts).toEqual([true, false, false, true]);
  });
});
