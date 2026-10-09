/** Synchronous diagnostic receipts for exits and catchable termination signals.
 * Both armed preloads share one observer so they finish writing before Node's
 * default signal action is restored. This never turns a signal into exit(0). */
import { isMainThread } from 'node:worker_threads';

const key = Symbol.for('papercusp.process-termination-observer.v1');

/**
 * @typedef {{ phase: 'exit' | 'signal', exitCode: number | null, signal: 'SIGTERM' | 'SIGINT' | null }} Termination
 */

/**
 * Observe synchronously without replacing application signal handlers. SIGKILL
 * cannot be observed; absence of a receipt must remain unknown to consumers.
 * @param {(termination: Termination) => void} callback
 * @returns {void}
 */
export function observeProcessTermination(callback) {
  let state = process[key];
  if (!state) {
    state = { callbacks: new Set() };
    process[key] = state;
    const notify = termination => {
      for (const observe of state.callbacks) {
        try { observe(termination); }
        catch (error) {
          // A broken diagnostic must not prevent the native termination action.
          try { process.stderr.write('PROCESS_TERMINATION_OBSERVER: ' + String(error) + '\n'); } catch {}
        }
      }
    };
    process.once('exit', exitCode => notify({ phase: 'exit', exitCode, signal: null }));
    if (isMainThread) {
      // Signal listeners disable Node's native action, but their libuv handles
      // are unreferenced. A short-lived process can otherwise exit before a
      // pending signal dispatches. Give the poll phase one final turn without
      // keeping a naturally completed process alive indefinitely.
      process.once('beforeExit', () => setImmediate(() => {}));
    }
    if (isMainThread) for (const signal of ['SIGTERM', 'SIGINT']) {
      const observer = () => {
        const hasApplicationHandler = process.listeners(signal).some(listener => listener !== observer);
        try { notify({ phase: 'signal', exitCode: null, signal }); }
        finally {
          // Installing a listener disables Node's native default. Re-raise the
          // SAME signal only when there was no application handler to own it.
          // Snapshot before dispatch: once-handlers may remove themselves later.
          if (!hasApplicationHandler) {
            process.removeListener(signal, observer);
            process.kill(process.pid, signal);
          }
        }
      };
      process.prependListener(signal, observer);
    }
  }
  state.callbacks.add(callback);
}
