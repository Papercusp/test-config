/** P-016: file-level execution observations, never case-level or universal coverage. */
import { createHash } from 'node:crypto';
import { isAbsolute, relative } from 'node:path';

export const COVERAGE_MAX_FILES = 200;
export const COVERAGE_MAX_LINES = 10_000;
export const COVERAGE_MAX_BYTES = 256_000;
export const COVERAGE_RETENTION_MS = 7 * 86_400_000;
export const COVERAGE_MAX_ROWS = 2_000;
export const coverageHash = (text: string | Uint8Array): string => createHash('sha256').update(text).digest('hex');
export interface CoverageSource {
  path: string;
  sha256: string;
  executable: number[];
  covered: number[];
}
export interface TestCoverageSnapshot {
  schemaVersion: 1;
  /** Both roots are physical: two checkouts must never share observations. */
  root: string;
  scopeRoot: string;
  testFile: string;
  testSha256: string;
  observedAt: string;
  /** False for filtered, failed, skipped, reused, ambiguous or truncated populations. */
  populationComplete: boolean;
  population: { path: string; sha256: string }[];
  sources: CoverageSource[];
}
export function coveragePath(root: string, absolute: string): string | null {
  const path = relative(root, absolute).replaceAll('\\', '/');
  return path && !isAbsolute(path) && !path.split('/').some(p => p === '..' || p === '.' || !p)
    && !/[\u0000-\u001f]/.test(path) ? path : null;
}
const safePath = (path: unknown): path is string => typeof path === 'string' && path.length > 0
  && path.length < 1_024 && !isAbsolute(path) && !/[\\\u0000-\u001f]/.test(path)
  && !path.split('/').some(p => !p || p === '.' || p === '..');
const digest = (s: unknown): s is string => typeof s === 'string' && /^[a-f0-9]{64}$/.test(s);
const lines = (s: unknown): s is number[] => Array.isArray(s) && s.length <= COVERAGE_MAX_LINES
  && s.every((n, i) => Number.isSafeInteger(n) && n > 0 && (i === 0 || n > s[i - 1]));
export function parseTestCoverage(value: unknown): TestCoverageSnapshot | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as TestCoverageSnapshot;
  if (v.schemaVersion !== 1 || typeof v.root !== 'string' || !isAbsolute(v.root)
    || typeof v.scopeRoot !== 'string' || !isAbsolute(v.scopeRoot) || !safePath(v.testFile)
    || !digest(v.testSha256) || typeof v.observedAt !== 'string' || !Number.isFinite(Date.parse(v.observedAt))
    || typeof v.populationComplete !== 'boolean' || !Array.isArray(v.population)
    || v.population.length === 0 || v.population.length > COVERAGE_MAX_FILES
    || !Array.isArray(v.sources) || v.sources.length > COVERAGE_MAX_FILES) return null;
  if (v.population.some(s => !s || !safePath(s.path) || !digest(s.sha256))
    || new Set(v.population.map(s => s.path)).size !== v.population.length
    || !v.population.some(s => s.path === v.testFile && s.sha256 === v.testSha256)) return null;
  if (v.sources.some(s => !s || !safePath(s.path) || !digest(s.sha256) || !lines(s.executable) || !lines(s.covered)
    || s.covered.some(line => !s.executable.includes(line)))
    || new Set(v.sources.map(s => s.path)).size !== v.sources.length
    || Buffer.byteLength(JSON.stringify(v)) > COVERAGE_MAX_BYTES) return null;
  return v;
}

/** Istanbul's source-mapped statement locations; a zero-count branch is never covered. */
export function coverageLines(file: { statementMap: Record<string, { start: { line: number }; end: { line: number } }>;
  s: Record<string, number> }): Pick<CoverageSource, 'executable' | 'covered'> {
  const hits = new Map<number, boolean>();
  for (const [id, location] of Object.entries(file.statementMap)) {
    // Multi-line declarations do not prove every interior line executed. Use statement starts.
    const line = location.start.line;
    if (!Number.isSafeInteger(line) || line < 1) continue;
    hits.set(line, (hits.get(line) ?? true) && file.s[id]! > 0);
  }
  const executable = [...hits.keys()].sort((a, b) => a - b);
  return { executable, covered: executable.filter(line => hits.get(line)) };
}
