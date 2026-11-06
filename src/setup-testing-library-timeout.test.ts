import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@testing-library/dom', () => {
  throw new Error('Cannot find package @testing-library/dom');
});

describe('setup-testing-library-timeout', () => {
  it('keeps the optional import out of Vite static resolution', () => {
    const source = readFileSync(new URL('./setup-testing-library-timeout.ts', import.meta.url), 'utf8');
    expect(source).toContain("const testingLibraryDomSpecifier: string = '@testing-library/dom';");
    expect(source).toContain('/* @vite-ignore */');
    expect(source).not.toContain("import('@testing-library/dom')");
  });

  it('loads when the optional @testing-library/dom dependency is absent', async () => {
    vi.resetModules();
    await expect(import('./setup-testing-library-timeout.ts')).resolves.toBeDefined();
  });
});
