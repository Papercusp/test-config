/** Synchronous diagnostic receipts for exits and catchable termination signals.
 * Both armed preloads share one observer so they finish writing before Node's
 * default signal action is restored. This never turns a signal into exit(0). */
import { isMainThread } from 'node:worker_threads';

const key = Symbol.for('papercusp.process-termination-observer.v1');

/**
 * @typedef {{ phase: 'exit' | 'signal', exitCode: number | null, signal: 'SIGTERM' | 'SIGINT' | null }} Termination
 * @typedef {{ phase: 'self-kill-request', exitCode: null, signal: 'SIGKILL', pid: number }} SelfKillRequest
 */

/**
 * Observe synchronously without replacing application signal handlers. SIGKILL
 * cannot be caught. An opt-in callback can observe a direct self-kill request
 * before delegating the unchanged native call; it is never a terminal verdict.
 * @param {(termination: Termination) => void} callback
 * A selfKillBoundary callback runs after all ordinary self-kill observers,
 * immediately before native delegation. Only one boundary may be registered.
 * This ordering alone does not prove native identity or a held execution fence.
 * @param {{ beforeSelfKill?: (request: SelfKillRequest) => void, selfKillFailed?: () => void, selfKillBoundary?: boolean }} [options]
 * @returns {void}
 */
export function observeProcessTermination(callback, options = {}) {
  if (options.selfKillBoundary && typeof options.beforeSelfKill !== 'function')
    throw new TypeError('A self-kill boundary requires a beforeSelfKill callback');
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
  if (options.beforeSelfKill) {
    if (!state.selfKillCallbacks) {
      state.selfKillCallbacks = new Set();
      state.selfKillFailureCallbacks = new Set();
      state.selfKillBoundary = null;
      state.selfKillDispatchVersion = 2;
      const originalKill = process.kill;
      const apply = Reflect.apply;
      const ownDescriptor = Object.getOwnPropertyDescriptor;
      const hasOwn = Object.hasOwn;
      const originalDelegate = ownDescriptor(process, '_kill');
      const killDelegate = originalDelegate && hasOwn(originalDelegate, 'value') ? originalDelegate.value : null;
      let notifying = false;
      process.kill = function(pid, signal, ...args) {
        if (!notifying && pid === process.pid && (signal === 'SIGKILL' || signal === 9)) {
          notifying = true;
          try {
            const boundary = state.selfKillBoundary;
            for (const observe of state.selfKillCallbacks) {
              try { observe({ phase: 'self-kill-request', exitCode: null, signal: 'SIGKILL', pid }); }
              catch { /* A diagnostic must not prevent or replace the native kill. */ }
            }
            // Never return to another observer after the terminal snapshot.
            // In particular the boundary is independent of registration order.
            // Node's public kill function itself calls process._kill. Inspect
            // its data descriptor AFTER ordinary observers, without invoking
            // an accessor. Drift withholds the terminal callback/END while
            // preserving the application's actual native-call semantics.
            const delegate = boundary ? ownDescriptor(process, '_kill') : null;
            if (boundary && typeof killDelegate === 'function' && delegate &&
                hasOwn(delegate, 'value') && delegate.value === killDelegate) {
              try { boundary({ phase: 'self-kill-request', exitCode: null, signal: 'SIGKILL', pid }); }
              catch { /* The independently observed native result remains required. */ }
            }
          } finally { notifying = false; }
        }
        // A function's .call property is mutable application state. Do not
        // invoke it after the boundary; delegate through the captured intrinsic.
        try { return apply(originalKill, this, [pid, signal, ...args]); }
        catch (error) {
          if (pid === process.pid && (signal === 'SIGKILL' || signal === 9))
            for (const failed of state.selfKillFailureCallbacks) {
              try { failed(); } catch { /* Preserve the exact native exception. */ }
            }
          throw error;
        }
      };
    }
    if (options.selfKillBoundary) {
      if (state.selfKillDispatchVersion !== 2)
        throw new Error('The existing self-kill dispatcher cannot enforce a terminal boundary');
      if (state.selfKillBoundary && state.selfKillBoundary !== options.beforeSelfKill)
        throw new Error('A self-kill boundary is already registered');
      state.selfKillBoundary = options.beforeSelfKill;
      state.selfKillCallbacks.delete(options.beforeSelfKill);
    } else if (state.selfKillBoundary !== options.beforeSelfKill) {
      state.selfKillCallbacks.add(options.beforeSelfKill);
    }
    if (options.selfKillFailed) state.selfKillFailureCallbacks.add(options.selfKillFailed);
  }
  state.callbacks.add(callback);
}
