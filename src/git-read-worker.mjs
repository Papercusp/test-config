// Private transport for admin-test-runs-reporter's bounded POSIX Git reads.
// Keep the deadline and stream callbacks on this loop, independent of synchronous
// work in Vitest's reporter loop. No test/config modules are loaded here.
import { spawn } from 'node:child_process';
import { parentPort, workerData } from 'node:worker_threads';

const { cmd, cwd, timeoutMs } = workerData;
const startedAt = Date.now();
let settled = false;
let killed = false;
let stdout = '';
let stderr = '';
let stdoutBytes = 0;
let stderrBytes = 0;
let timer;
let child;
let terminationReason;

function finish(error, code = null, signal = null) {
  if (settled) return;
  settled = true;
  if (timer) clearTimeout(timer);
  const failed = Boolean(error) || killed || code !== 0;
  parentPort.postMessage({ type: 'result', output: failed ? null : stdout.trim(),
    ...(failed ? { diagnostic: JSON.stringify({ command: cmd, timeoutMs,
      elapsedMs: Date.now() - startedAt, code: error?.code ?? code, signal, killed,
      message: (terminationReason ?? error?.message ?? '').slice(0, 512),
      stderr: stderr.trim().slice(-512) }) } : {}),
  });
  parentPort.close();
}

function stop(reason) {
  if (settled || killed) return;
  killed = true;
  terminationReason = reason;
  try { if (child?.pid) process.kill(-child.pid, 'SIGKILL'); }
  catch { try { child?.kill('SIGKILL'); } catch { /* Already gone. */ } }
  child?.stdout?.destroy();
  child?.stderr?.destroy();
  finish(undefined, child?.exitCode ?? null, child?.signalCode ?? 'SIGKILL');
}

try {
  child = spawn(cmd, { cwd, shell: true, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  if (child.pid) parentPort.postMessage({ type: 'spawned', pid: child.pid });
  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');
  child.stdout?.on('data', chunk => {
    stdoutBytes += Buffer.byteLength(chunk);
    if (stdoutBytes > 1024 * 1024) stop('stdout maxBuffer length exceeded');
    else stdout += chunk;
  });
  child.stderr?.on('data', chunk => {
    stderrBytes += Buffer.byteLength(chunk);
    if (stderrBytes > 1024 * 1024) stop('stderr maxBuffer length exceeded');
    else stderr += chunk;
  });
  child.once('error', error => finish(error));
  child.once('close', (code, signal) => finish(undefined, code, signal));
  if (timeoutMs > 0) timer = setTimeout(() => stop('command timed out'), timeoutMs);
} catch (error) { finish(error); }
