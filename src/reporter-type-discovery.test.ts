/** EI-26154571958613818: postgres.js leaves its startup array-type probe
 * unobserved when shutdown interrupts it. Exercise the real driver over a tiny
 * protocol peer; no product/test Postgres or arbitrary timing race is involved.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { closeSharedPg, tryGetPg } from './admin-test-runs-reporter.ts';

const run = promisify(execFile);
const child = String.raw`
  import net from 'node:net';
  import postgres from 'postgres';
  const unhandled = [];
  process.on('unhandledRejection', error => unhandled.push({ code: error.code, query: error.query }));
  let resolveQuery;
  const seen = new Promise(resolve => { resolveQuery = resolve; });
  const sockets = new Set();
  const packet = (tag, body) => {
    const header = Buffer.alloc(5); header.write(tag); header.writeInt32BE(body.length + 4, 1);
    return Buffer.concat([header, body]);
  };
  const server = net.createServer(socket => {
    sockets.add(socket); socket.on('error', () => {});
    let startup = true, buffered = Buffer.alloc(0);
    socket.on('data', bytes => {
      buffered = Buffer.concat([buffered, bytes]);
      while (buffered.length >= (startup ? 4 : 5)) {
        const length = buffered.readInt32BE(startup ? 0 : 1) + (startup ? 0 : 1);
        if (buffered.length < length) return;
        const message = buffered.subarray(0, length); buffered = buffered.subarray(length);
        if (startup) {
          startup = false;
          socket.write(Buffer.concat([packet('R', Buffer.alloc(4)), packet('K', Buffer.alloc(8)), packet('Z', Buffer.from('I'))]));
        } else if (message[0] === 81) {
          resolveQuery(message.subarray(5, message.length - 1).toString());
        } else if (message[0] === 80) {
          const body = message.subarray(5), start = body.indexOf(0) + 1;
          resolveQuery(body.subarray(start, body.indexOf(0, start)).toString());
          // Deliberately hold this statement until the reporter ends its client.
        }
      }
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const sql = postgres({ host: '127.0.0.1', port: server.address().port,
    database: 'fixture', username: 'fixture', max: 1, connect_timeout: 5,
    fetch_types: JSON.parse(process.argv[1]), onnotice() {} });
  const statement = sql.unsafe('select 1').catch(() => {});
  const timer = setTimeout(() => { throw new Error('protocol fixture saw no query'); }, 7000);
  const query = await seen; clearTimeout(timer);
  await sql.end({ timeout: 0 }); await statement;
  await new Promise(resolve => setImmediate(() => setImmediate(resolve)));
  for (const socket of sockets) socket.destroy();
  await new Promise(resolve => server.close(resolve));
  console.log(JSON.stringify({ query, unhandled }));
`;

async function interrupt(fetchTypes: boolean) {
  const result = await run(process.execPath, ['--input-type=module', '-e', child, String(fetchTypes)], {
    timeout: 12_000, maxBuffer: 32_768,
  });
  return JSON.parse(result.stdout.trim().split('\n').at(-1)!);
}

afterEach(async () => { await closeSharedPg(); vi.unstubAllEnvs(); });

describe('reporter shutdown during postgres startup', () => {
  it('CONTROL: interrupting driver array discovery causes the observed unhandled rejection', async () => {
    const result = await interrupt(true);
    expect(result.query).toContain('pg_catalog.pg_type');
    expect(result.unhandled).toEqual([expect.objectContaining({ code: 'CONNECTION_DESTROYED' })]);
  }, 15_000);

  it('the real reporter client submits its statement without the unsafe startup probe', async () => {
    vi.stubEnv('PAPERCUSP_TEST_RUNS_DB_URL', 'postgresql://fixture@127.0.0.1:1/fixture');
    const handle = await tryGetPg();
    expect(handle).not.toBeNull();
    const sql = handle!.sql as unknown as { options: { fetch_types: boolean } };
    const result = await interrupt(sql.options.fetch_types);
    expect(result.query).toBe('select 1');
    expect(result.unhandled).toEqual([]);
  }, 15_000);
});
