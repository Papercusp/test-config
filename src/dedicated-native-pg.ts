/**
 * A DEDICATED, per-run NATIVE Postgres cluster — the Docker-free sibling of
 * `startDedicatedTestPg` (pg-container.ts), for a suite that must own its whole
 * cluster (the P-013 benchmark rigs: WAL/fsync counters are cluster-wide).
 *
 * Why this exists (measured 2026-09-27, P-013 workload D, WI-10003492): Docker
 * container CREATE on this host blocked for 2–30 min inside `umount2` — the
 * daemon's goroutine dump showed every `postContainersCreate` parked in
 * `overlay2.(*Driver).Put → unix.Unmount` under root-disk writeback pressure
 * (WI-10003403) — so four consecutive rig repetitions died `socket hang up` in
 * `beforeAll` before measuring anything. A cluster started from the host's own
 * PG binaries needs no daemon, no overlay mount, and can put its data directory
 * on a chosen device.
 *
 * The cluster is a plain CHILD process (not detached): it is stopped by `stop()`
 * and its data directory removed. Durability is left at server defaults
 * (fsync on); only `initdb` skips its final sync, exactly like the container
 * path's `TEST_PG_INITDB_ARGS = "--no-sync"`.
 */
import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { probePgReachable } from './pg-reachability.ts';

// Lazy + memoized, NOT promisified at module scope (EI-10161): under a narrow
// `vi.mock('node:child_process')` `execFile` is undefined, and an eager `promisify` throws at
// IMPORT time — crashing every test file that reaches this module, even one that never calls it.
let execFilePMemo: typeof execFile.__promisify__ | null = null;
const execFileP = ((...args: unknown[]) =>
  Reflect.apply((execFilePMemo ??= promisify(execFile)), undefined, args)) as typeof execFile.__promisify__;

export interface DedicatedNativePg {
  /** Superuser (`postgres`, trust auth over 127.0.0.1) URI of the `postgres` database. */
  getConnectionUri(): string;
  readonly dataDir: string;
  readonly port: number;
  stop(opts?: { timeout?: number }): Promise<void>;
}

/** Newest `/usr/lib/postgresql/<major>/bin` that has `initdb`, or `PAPERCUSP_NATIVE_PG_BIN`. */
export function resolveNativePgBinDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.PAPERCUSP_NATIVE_PG_BIN;
  if (override) {
    if (!existsSync(join(override, 'initdb'))) {
      throw new Error(`PAPERCUSP_NATIVE_PG_BIN=${override} has no initdb`);
    }
    return override;
  }
  for (let major = 30; major >= 14; major--) {
    const dir = `/usr/lib/postgresql/${major}/bin`;
    if (existsSync(join(dir, 'initdb')) && existsSync(join(dir, 'postgres'))) return dir;
  }
  throw new Error(
    'startDedicatedNativePg: no native Postgres binaries found under /usr/lib/postgresql/*/bin ' +
      '(set PAPERCUSP_NATIVE_PG_BIN to a directory containing initdb + postgres).',
  );
}

async function freeLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => (port ? resolve(port) : reject(new Error('no port assigned'))));
    });
  });
}

/** `-c name=value` argv for the given server settings (order preserved). */
export function nativePgSettingArgs(settings: Record<string, string>): string[] {
  return Object.entries(settings).flatMap(([k, v]) => ['-c', `${k}=${v}`]);
}

export async function startDedicatedNativePg(
  opts: { settings?: Record<string, string>; baseDir?: string; readyBudgetMs?: number } = {},
): Promise<DedicatedNativePg> {
  const bin = resolveNativePgBinDir();
  const dataDir = await mkdtemp(join(opts.baseDir ?? tmpdir(), 'papercusp-native-pg-'));
  let child: ChildProcess | undefined;
  const cleanupDir = () => rm(dataDir, { recursive: true, force: true }).catch(() => undefined);
  try {
    await execFileP(
      join(bin, 'initdb'),
      ['-D', dataDir, '-U', 'postgres', '-A', 'trust', '-E', 'UTF8', '--locale=C', '--no-sync'],
      { maxBuffer: 16 * 1024 * 1024 },
    );
    const port = await freeLoopbackPort();
    const logTail: string[] = [];
    child = spawn(
      join(bin, 'postgres'),
      [
        '-D', dataDir,
        '-p', String(port),
        '-c', 'listen_addresses=127.0.0.1',
        // WI-10004469: no Unix socket. Every caller connects over TCP 127.0.0.1, and a
        // socket in dataDir fails startup outright once `<baseDir>/papercusp-native-pg-XXXXXX/
        // .s.PGSQL.<port>` exceeds the kernel's 107-byte sun_path limit
        // ("FATAL: could not create any Unix-domain sockets") — a long TMPDIR was enough.
        '-c', 'unix_socket_directories=',
        // Keep server messages on stderr, where logTail captures them. With the collector
        // on, a startup FATAL went to <dataDir>/log, which cleanup deletes, so the error
        // carried no cause.
        '-c', 'logging_collector=off',
        ...nativePgSettingArgs(opts.settings ?? {}),
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    const keep = (b: Buffer) => {
      logTail.push(b.toString());
      if (logTail.length > 40) logTail.shift();
    };
    child.stdout?.on('data', keep);
    child.stderr?.on('data', keep);
    // A postmaster that dies at startup must end the wait at once rather than after the
    // whole readiness budget. 'close' (not 'exit') fires after stdio drains, so the
    // FATAL is already in logTail when the error below is built.
    const postmasterGone = new AbortController();
    let postmasterExit: string | undefined;
    child.once('close', (code, signal) => {
      postmasterExit = `postmaster exited before accepting connections (code ${code ?? 'null'}, signal ${signal ?? 'none'})`;
      postmasterGone.abort();
    });
    const uri = `postgres://postgres@127.0.0.1:${port}/postgres`;
    const ready = await probePgReachable(uri, opts.readyBudgetMs ?? 60_000, { signal: postmasterGone.signal });
    if (!ready.ok) {
      throw new Error(
        `startDedicatedNativePg: cluster never answered SELECT 1 within ${ready.elapsedMs}ms ` +
          `(${postmasterExit ?? ready.lastError}); server log tail:\n${logTail.join('')}`,
      );
    }
    const proc = child;
    let stopped = false;
    return {
      dataDir,
      port,
      getConnectionUri: () => uri,
      async stop(stopOpts = {}) {
        if (stopped) return;
        stopped = true;
        await stopChild(proc, stopOpts.timeout ?? 10_000);
        await cleanupDir();
      },
    };
  } catch (e) {
    if (child) await stopChild(child, 5_000);
    await cleanupDir();
    throw e;
  }
}

/** SIGINT = Postgres "fast" shutdown; SIGKILL if it does not exit in time. */
async function stopChild(child: ChildProcess, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  child.kill('SIGINT');
  const timer = new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), timeoutMs));
  if ((await Promise.race([exited, timer])) === 'timeout') {
    child.kill('SIGKILL');
    await exited;
  }
}
