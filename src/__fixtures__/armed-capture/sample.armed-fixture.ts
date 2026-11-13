import { createReadStream, readFileSync } from 'node:fs';
import { open, opendir } from 'node:fs/promises';
import { expect, it, vi } from 'vitest';

// Fixture test run by executed-inputs-capture-armed-run.test.ts inside a child vitest. It reads
// one file so the armed capture has an input to record.
async function readFixtureInput() {
  expect(readFileSync(new URL('./input.txt', import.meta.url), 'utf8')).toBe('armed-capture-input\n');
  const handle = await open(new URL('./input.txt', import.meta.url), 'r');
  try { expect(await handle.readFile('utf8')).toBe('armed-capture-input\n'); }
  finally { await handle.close(); }
  const chunks: Buffer[] = [];
  for await (const chunk of createReadStream(new URL('./input.txt', import.meta.url))) chunks.push(chunk);
  expect(Buffer.concat(chunks).toString()).toBe('armed-capture-input\n');
  const directory = await opendir(new URL('.', import.meta.url));
  const entries = [];
  for await (const entry of directory) entries.push(entry.name);
  expect(entries).toContain('input.txt');
}
it('reads one input file', readFixtureInput);

it('executes a route imported after collection and resetModules with a mocked dependency', async () => {
  vi.resetModules();
  vi.doMock('./dynamic-dependency.fixture.ts', () => ({ value: 'mocked' }));
  const { route } = await import('./dynamic-route.fixture.ts');
  expect(route()).toBe('mocked');
  const querystring = await import('node:querystring');
  expect(querystring.stringify({ observed: 'external' })).toBe('observed=external');
});
