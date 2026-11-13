import { createReadStream, readFileSync } from 'node:fs';
import { open, opendir } from 'node:fs/promises';
import { createConnection, createServer, type Socket, type AddressInfo } from 'node:net';
import { Worker } from 'node:worker_threads';
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
  let peer: Socket | undefined;
  const server = createServer(socket => { peer = socket; socket.end('socket-input'); });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const socket = createConnection((server.address() as AddressInfo).port, '127.0.0.1');
  try {
    const received: Buffer[] = [];
    for await (const chunk of socket) received.push(chunk);
    expect(Buffer.concat(received).toString()).toBe('socket-input');
  } finally {
    socket.destroy(); peer?.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
  const worker = new Worker(`
    const { parentPort } = require('node:worker_threads');
    parentPort.once('message', value => parentPort.postMessage(value));
  `, { eval: true });
  try {
    const received = new Promise<string>((resolve, reject) => {
      worker.once('message', resolve);
      worker.once('error', reject);
    });
    worker.postMessage('worker-input');
    expect(await received).toBe('worker-input');
  } finally { await worker.terminate(); }
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
