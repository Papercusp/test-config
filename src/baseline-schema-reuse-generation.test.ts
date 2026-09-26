import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  readBaselineReuseGeneration,
  replaceInvalidBaselineCandidate,
  rotateBaselineReuseGeneration,
} from './baseline-schema-global-setup.ts';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('baseline container reuse rotation', () => {
  it('persists a new generation for later Vitest processes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'baseline-reuse-'));
    roots.push(root);
    expect(await readBaselineReuseGeneration(root)).toBe(0);
    expect(await rotateBaselineReuseGeneration(root)).toBe(1);
    expect(await readBaselineReuseGeneration(root)).toBe(1);
    expect(await rotateBaselineReuseGeneration(root)).toBe(2);
    expect(await readFile(join(root, 'baseline-schema-reuse-generation'), 'utf8')).toBe('2\n');
  });

  it('replaces an invalid candidate without stopping readers attached to it', async () => {
    const old = { stop: vi.fn() };
    const fresh = { stop: vi.fn() };
    const start = vi.fn(async (generation: number) => {
      expect(generation).toBe(1);
      return fresh;
    });
    const rotate = vi.fn(async () => 1);
    expect(await replaceInvalidBaselineCandidate(old, async () => false, start, rotate)).toBe(fresh);
    expect(old.stop).not.toHaveBeenCalled();
    expect(start).toHaveBeenCalledOnce();
    expect(rotate).toHaveBeenCalledOnce();

    expect(await replaceInvalidBaselineCandidate(fresh, async () => true, start, rotate)).toBe(fresh);
    expect(start).toHaveBeenCalledOnce();
    expect(rotate).toHaveBeenCalledOnce();
  });
});
