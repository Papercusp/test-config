// Private transport for admin-test-runs-reporter's bounded POSIX Git reads.
// Keep the deadline and stream callbacks on this loop, independent of synchronous
// work in Vitest's reporter loop. No test/config modules are loaded here.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { parentPort, workerData } from 'node:worker_threads';

const { cmd, cwd, timeoutMs } = workerData;
const summarizeStatus = cmd === 'git status --porcelain --untracked-files=all';
const captureLimit = 1024 * 1024;
const statusDigest = summarizeStatus ? createHash('sha256') : null;
const statusPrefix = [];
let statusPrefixBytes = 0;
let statusLines = 0;
let statusLastByte;
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

function capturedOutput() {
  if (!summarizeStatus) return stdout.trim();
  const prefix = Buffer.concat(statusPrefix, statusPrefixBytes);
  if (stdoutBytes <= captureLimit) return prefix.toString('utf8').trim();
  // A large status is positive evidence of dirt, not an unreadable command.
  // Drain/hash every byte while retaining the original memory bound. The
  // non-porcelain header survives mutation-subject exemption: omitted paths
  // must never disappear merely because the retained subject was exempted.
  const sample = prefix.subarray(0, 8192);
  const lastNewline = sample.lastIndexOf(10);
  const paths = lastNewline < 0 ? '' : sample.subarray(0, lastNewline).toString('utf8');
  const lines = statusLines + (statusLastByte === 10 ? 0 : 1);
  return `# reporter git-status summary: bytes=${stdoutBytes} lines=${lines} sha256=${statusDigest.digest('hex')}\n${paths}`.trimEnd();
}

function finish(error, code = null, signal = null) {
  if (settled) return;
  settled = true;
  if (timer) clearTimeout(timer);
  const failed = Boolean(error) || killed || code !== 0;
  parentPort.postMessage({ type: 'result', output: failed ? null : capturedOutput(),
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
  if (!summarizeStatus) child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');
  child.stdout?.on('data', chunk => {
    stdoutBytes += Buffer.byteLength(chunk);
    if (summarizeStatus) {
      statusDigest.update(chunk);
      for (const byte of chunk) if (byte === 10) statusLines++;
      statusLastByte = chunk.at(-1);
      const retained = Math.min(chunk.length, captureLimit - statusPrefixBytes);
      if (retained > 0) {
        statusPrefix.push(Buffer.from(chunk.subarray(0, retained)));
        statusPrefixBytes += retained;
      }
    } else if (stdoutBytes > captureLimit) stop('stdout maxBuffer length exceeded');
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
