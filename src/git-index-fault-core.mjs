// Portable Git index classification and bounded read retry. Host audit/CLI stays in scripts/lib/git-index-fault.mjs.
/**
 * Git's own error strings for an unreadable/torn index, from read-cache.c.
 *
 * Each is unambiguous about the INDEX specifically — none can be produced by a guard's own
 * logic, a missing file, or an ordinary non-zero lint exit. Anything less specific (a bare
 * "fatal:", "cannot read", an exit code alone) is deliberately NOT here: see SCOPE DISCIPLINE.
 */
const INDEX_FAULT_PATTERNS = [
  /index file smaller than expected/i,
  /bad index file sha1 signature/i,
  /index file corrupt/i,
  /unknown index entry format/i,
  /malformed index info/i,
  /broken index file/i,
  /\.git[/\\]index[^\n]*\b(?:corrupt|truncated)\b/i,
];

/**
 * The git diagnostic itself, not the wrapper's framing.
 *
 * execFileSync's own `error.message` leads with "Command failed: git ls-files …", which says
 * nothing about WHY. Pull the line that actually matched, so the NOT CHECKED banner quotes
 * git ("index file smaller than expected") rather than a generic failure notice.
 */
export function indexFaultDiagnostic(error) {
  const lines = errorText(error).split('\n');
  const matched = lines.find((line) => INDEX_FAULT_PATTERNS.some((re) => re.test(line)));
  return (matched ?? lines.find(Boolean) ?? '(no diagnostic)').trim();
}

/** Text a thrown child-process error can carry the git diagnostic in. */
export function errorText(error) {
  if (!error) return '';
  const parts = [
    error.message,
    error.stderr,
    error.stdout,
    Array.isArray(error.output) ? error.output.join('\n') : undefined,
  ];
  return parts
    .map((p) => (p == null ? '' : Buffer.isBuffer(p) ? p.toString('utf8') : String(p)))
    .join('\n');
}

/**
 * Is this error git telling us the repository index is unreadable?
 *
 * TRUE means "the instrument failed", never "the subject is in violation". Callers must convert
 * a true here into an UNDETERMINED verdict, never into a finding and never into a silent pass.
 */
export function isRepositoryIndexFault(error) {
  const text = errorText(error);
  if (!text) return false;
  return INDEX_FAULT_PATTERNS.some((re) => re.test(text));
}

/** Thrown when the index is still unreadable after every retry. */
export class RepositoryIndexFaultError extends Error {
  constructor(message, { attempts, cause } = {}) {
    super(message);
    this.name = 'RepositoryIndexFaultError';
    this.isRepositoryIndexFault = true;
    this.attempts = attempts;
    this.cause = cause;
  }
}

/**
 * Sleep on the main thread.
 *
 * These guards are synchronous end to end (execFileSync), so the retry has to be too. Atomics
 * .wait on a private SharedArrayBuffer is the supported synchronous sleep in Node; a busy-wait
 * would burn a core on a box that is already contended enough to tear an index in the first place.
 */
export function sleepSync(ms) {
  if (!(ms > 0)) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Run a git-reading closure, retrying only the repository-index-fault class.
 *
 * Any OTHER error propagates untouched and immediately — this widens nothing, it only makes the
 * one known-transient, known-self-healing fault recoverable. Returns the closure's value; throws
 * RepositoryIndexFaultError if the index is still unreadable after `attempts`.
 *
 * Defaults (4 attempts, 250ms, doubling → ~1.75s worst case) are sized to git-sync's repair
 * window while staying far below any guard's own runtime, so a healthy run pays nothing at all:
 * the retry path is entered only after a fault has already been classified.
 *
 * @template T
 * @param {() => T} run
 * @param {{ attempts?: number, delayMs?: number, onRetry?: (info: { attempt: number, of: number, delayMs: number, error: unknown }) => void }} [options]
 * @returns {T}
 */
export function withGitIndexFaultRetry(run, { attempts = 4, delayMs = 250, onRetry } = {}) {
  const total = Math.max(1, attempts);
  let lastError;

  for (let attempt = 1; attempt <= total; attempt += 1) {
    try {
      return run();
    } catch (error) {
      if (!isRepositoryIndexFault(error)) throw error;
      lastError = error;
      if (attempt < total) {
        const wait = delayMs * 2 ** (attempt - 1);
        if (typeof onRetry === 'function') onRetry({ attempt, of: total, delayMs: wait, error });
        sleepSync(wait);
      }
    }
  }

  throw new RepositoryIndexFaultError(
    `repository index unreadable after ${total} attempt(s): ${indexFaultDiagnostic(lastError)}`,
    { attempts: total, cause: lastError },
  );
}

