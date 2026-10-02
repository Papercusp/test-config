import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { captureCollectedSources, qualifyCollectedSources } from './executed-source-map-reporter';

const ROOT = '/repo';
const SELF = '/repo/test.test.ts';
const DEP = '/repo/dep.ts';
const hash = (content: string) => createHash('sha256').update(content).digest('hex');
const contents = new Map([[SELF, 'test body'], [DEP, 'export const answer = 42;']]);
const node = (id: string, content = contents.get(id)) => ({
  id, transformResult: { map: { sources: [id], sourcesContent: [content] } },
});
const readSource = (path: string): Buffer => {
  const content = contents.get(path);
  if (content === undefined) throw new Error('unreadable');
  return Buffer.from(content);
};
const options = { repoRoot: ROOT, testFile: SELF, readSource };

describe('prospective Vite source fingerprints (EI-24827847586322829)', () => {
  it('compares original imported source bytes, independently of an unrelated HEAD change', () => {
    const captured = captureCollectedSources([node(SELF), node(DEP)], options);
    const evidence = qualifyCollectedSources(captured, { [DEP]: {} }, options);
    expect(evidence).toEqual({
      schemaVersion: 'vite-collected-source-evidence-v1',
      scope: 'repository-worker-vite-original-sources', status: 'stable', reasons: [],
      sources: [
        { path: 'dep.ts', sha256: hash(contents.get(DEP)!), currentSha256: hash(contents.get(DEP)!) },
        { path: 'test.test.ts', sha256: hash(contents.get(SELF)!), currentSha256: hash(contents.get(SELF)!) },
      ],
    });
    // HEAD is deliberately not an input to this scoped observation.
    expect(qualifyCollectedSources(captured, { [DEP]: {} }, options)).toEqual(evidence);
  });

  it('detects an imported source changing, even if the live graph has been replaced', () => {
    const graph = [node(SELF), node(DEP)];
    const captured = captureCollectedSources(graph, options);
    graph[1] = node(DEP, 'replacement graph content');
    const evidence = qualifyCollectedSources(captured, { [DEP]: {} }, {
      ...options, readSource: path => path === DEP ? Buffer.from('replacement graph content') : readSource(path),
    });
    expect(evidence.status).toBe('changed');
    expect(evidence.reasons).toEqual(['source-changed:dep.ts']);
    expect(evidence.sources[0]!.sha256).toBe(hash(contents.get(DEP)!));
    expect(evidence.sources[0]!.currentSha256).toBe(hash('replacement graph content'));
  });

  it('refuses cached source-map bytes that disagree with disk at collection', () => {
    const captured = captureCollectedSources([node(SELF), node(DEP, 'cached old bytes')], options);
    expect(qualifyCollectedSources(captured, { [DEP]: {} }, options).reasons)
      .toContain('collection-source-mismatch:dep.ts');
  });

  it.each([
    ['no graph', undefined, 'collection-graph-unavailable'],
    ['no map', [node(SELF), { id: DEP }], 'source-map-unavailable:dep.ts'],
    ['missing content', [node(SELF), node(DEP, undefined)], 'source-map-content-unavailable:dep.ts'],
    ['unresolved source', [node(SELF), { id: DEP, transformResult: {
      map: { sources: ['/elsewhere/dep.ts'], sourcesContent: ['external'] },
    } }], 'source-map-path-unresolved:dep.ts'],
  ] as const)('leaves %s unknown', (_label, graph, reason) => {
    // Explicit undefined is not the helper's default content.
    const nodes = _label === 'missing content' ? [node(SELF), { id: DEP, transformResult: {
      map: { sources: [DEP], sourcesContent: [null] },
    } }] : graph;
    const captured = captureCollectedSources(nodes, options);
    const evidence = qualifyCollectedSources(captured, { [DEP]: {} }, options);
    expect(evidence.status).toBe('unknown');
    expect(evidence.reasons).toContain(reason);
  });

  it('leaves a newly observed dynamic import and native repository external unknown', () => {
    const captured = captureCollectedSources([node(SELF)], options);
    expect(qualifyCollectedSources(captured, { [DEP]: {} }, options)).toMatchObject({
      status: 'unknown', reasons: ['module-not-captured-at-collection:dep.ts'],
    });
    expect(qualifyCollectedSources(captured, { [DEP]: { external: true } }, options)).toMatchObject({
      status: 'unknown', reasons: ['repository-external:dep.ts'],
    });
  });

  it('does not treat missing end diagnostics or collection evidence as an empty source radius', () => {
    const captured = captureCollectedSources([node(SELF)], options);
    expect(qualifyCollectedSources(captured, {}, options).status).toBe('unknown');
    expect(qualifyCollectedSources(undefined, { [DEP]: {} }, options).status).toBe('unknown');
  });

  it('reports unreadable collection/end sources without fabricating a hash', () => {
    const unreadable = { ...options, readSource: () => { throw new Error('gone'); } };
    const captured = captureCollectedSources([node(SELF), node(DEP)], unreadable);
    const evidence = qualifyCollectedSources(captured, { [DEP]: {} }, unreadable);
    expect(evidence.status).toBe('unknown');
    expect(evidence.reasons).toContain('collection-source-unreadable:dep.ts');
    expect(evidence.reasons).toContain('source-unreadable:dep.ts');
    expect(evidence.sources.every(source => source.currentSha256 === null)).toBe(true);
  });

  it('refuses conflicting source versions for the same repository path', () => {
    const captured = captureCollectedSources([node(SELF), node(DEP), {
      id: `${DEP}?v=2`, transformResult: { map: { sources: [DEP], sourcesContent: ['other bytes'] } },
    }], options);
    const evidence = qualifyCollectedSources(captured, { [DEP]: {} }, options);
    expect(evidence.status).toBe('unknown');
    expect(evidence.reasons).toContain('conflicting-source-maps:dep.ts');
  });

  it('qualifies real Vite SSR map contents and detects a subsequent disk mutation', async () => {
    const root = mkdtempSync(join(tmpdir(), 'collected-vite-sources-'));
    const self = join(root, 'test.test.ts');
    const dep = join(root, 'dep.ts');
    writeFileSync(self, 'import { answer } from "./dep.ts"; export const observed = answer;\n');
    writeFileSync(dep, 'export const answer: number = 42;\n');
    const { createServer } = await import('vite');
    const server = await createServer({
      root, configFile: false, server: { middlewareMode: true, watch: null },
      optimizeDeps: { noDiscovery: true }, logLevel: 'silent',
    });
    try {
      const environment = server.environments.ssr!;
      await environment.transformRequest(self);
      await environment.transformRequest(dep);
      const captured = captureCollectedSources(environment.moduleGraph.idToModuleMap.values(), { repoRoot: root });
      const evidence = qualifyCollectedSources(captured, { [dep]: {} }, { repoRoot: root, testFile: self });
      expect(evidence.status).toBe('stable');
      expect(evidence.sources.find(source => source.path === 'dep.ts')!.sha256)
        .toBe(hash(readFileSync(dep, 'utf8')));
      writeFileSync(dep, 'export const answer: number = 99;\n');
      expect(qualifyCollectedSources(captured, { [dep]: {} }, { repoRoot: root, testFile: self }))
        .toMatchObject({ status: 'changed', reasons: ['source-changed:dep.ts'] });
    } finally {
      await server.close();
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);
});
