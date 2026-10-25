// Private transport for admin-test-runs-reporter's bounded POSIX Git reads.
// Keep the deadline and stream callbacks on this loop, independent of synchronous
// work in Vitest's reporter loop. No test/config modules are loaded here.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readlinkSync } from 'node:fs';
import { parentPort, workerData } from 'node:worker_threads';

const { cmd, cwd, timeoutMs } = workerData;
const summarizeStatus = cmd === 'git status --porcelain --untracked-files=all';
const captureLimit = 1024 * 1024;
// Trace2 gets its own pipe, so phase evidence never contaminates porcelain or
// stderr. Respect an explicitly configured destination. Keep only bounded
// phase metadata, not argv, paths, error messages, or an unbounded trace file.
const traceGit = /^git(?:\s|$)/.test(cmd) && !process.env.GIT_TRACE2_EVENT;
const traceLimit = 8192;
let tracePending = '';
let traceDiscarding = false;
let traceEvents = 0;
let traceDroppedLines = 0;
let traceRootProcessId;
const traceTail = [];
const traceRegions = new Map();
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

function captureTrace(chunk) {
  tracePending += chunk;
  let newline;
  while ((newline = tracePending.indexOf('\n')) >= 0) {
    const line = tracePending.slice(0, newline);
    tracePending = tracePending.slice(newline + 1);
    if (traceDiscarding || line.length > traceLimit) {
      if (!traceDiscarding) traceDroppedLines++;
      traceDiscarding = false;
      continue;
    }
    try {
      const event = JSON.parse(line);
      if (!event || typeof event !== 'object' || typeof event.event !== 'string') continue;
      traceEvents++;
      const phase = {};
      for (const key of ['event', 'category', 'label', 'key', 'value', 'thread', 'nesting', 't_abs', 't_rel']) {
        const value = event[key];
        if (typeof value === 'string') phase[key] = value.slice(0, 96);
        else if (typeof value === 'number' && Number.isFinite(value)) phase[key] = value;
      }
      if (typeof event.sid === 'string') {
        // Correlate root/submodule phases without retaining raw session IDs.
        const token = sid => createHash('sha256').update(sid).digest('hex').slice(0, 12);
        phase.processId = token(event.sid);
        const parentEnd = event.sid.lastIndexOf('/');
        if (parentEnd > 0) phase.parentProcessId = token(event.sid.slice(0, parentEnd));
        if (event.event === 'start' && !traceRootProcessId) traceRootProcessId = phase.processId;
      }
      // sid distinguishes submodule/helper processes whose nesting starts at 1
      // again. The full ID stays an internal matching key.
      const regionKey = JSON.stringify([event.sid, event.thread, event.nesting]);
      if (event.event === 'region_enter') {
        traceRegions.set(regionKey, phase);
        if (traceRegions.size > 12) traceRegions.delete(traceRegions.keys().next().value);
      } else if (event.event === 'region_leave') traceRegions.delete(regionKey);
      traceTail.push(phase);
      if (traceTail.length > 12) traceTail.shift();
    } catch { traceDroppedLines++; }
  }
  if (tracePending.length > traceLimit) {
    tracePending = '';
    if (!traceDiscarding) traceDroppedLines++;
    traceDiscarding = true;
  }
}

function failureContext() {
  const namespaces = {};
  if (process.platform === 'linux') {
    for (const kind of ['user', 'mnt']) {
      try { namespaces[kind] = readlinkSync(`/proc/self/ns/${kind}`); }
      catch { /* Missing procfs must not affect the reading. */ }
    }
  }
  return {
    identity: { uid: process.getuid?.(), gid: process.getgid?.(), namespaces },
    ...(traceGit ? { gitTrace: { events: traceEvents, droppedLines: traceDroppedLines,
      rootProcessId: traceRootProcessId,
      lastEvents: traceTail, openRegions: [...traceRegions.values()] } } : {}),
  };
}

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
      stderr: stderr.trim().slice(-512), ...failureContext() }) } : {}),
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
  child?.stdio?.[3]?.destroy();
  finish(undefined, child?.exitCode ?? null, child?.signalCode ?? 'SIGKILL');
}

try {
  child = spawn(cmd, { cwd, shell: true, detached: true,
    stdio: traceGit ? ['ignore', 'pipe', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe'],
    ...(traceGit ? { env: { ...process.env, GIT_TRACE2_EVENT: '3' } } : {}),
  });
  if (child.pid) parentPort.postMessage({ type: 'spawned', pid: child.pid });
  if (traceGit) {
    child.stdio[3].setEncoding('utf8');
    child.stdio[3].on('data', captureTrace);
    child.stdio[3].on('error', () => { /* Optional diagnostic pipe. */ });
  }
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
