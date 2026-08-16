import { n as isDebugFlagSet, r as setDebugSink } from "./debug-CH5E3t0A.js";
//#region src/lib/debug-messages.ts
const debugMessages = {
	1: "[nuq+ %s `%s`] State changed: %O",
	2: "[nuq+ %s `%s`] Cross-hook key sync %s: %O (default: %O). no change, skipping, resolved: %O",
	3: "[nuq+ %s `%s`] Cross-hook key sync %s: %O (default: %O). updateInternalState, resolved: %O",
	4: "[nuq+ %s `%s`] Subscribing to sync for `%s`",
	5: "[nuq+ %s `%s`] Unsubscribing to sync for `%s`",
	6: "[nuq+ %s `%s`] setState: %O",
	7: "[nuqs gtq] Enqueueing %s=%s %O",
	8: "[nuqs gtq] Skipping flush due to throttleMs=Infinity",
	9: "[nuqs gtq] Scheduling flush in %f ms. Throttled at %f ms (x%f)",
	10: "[nuqs gtq] Resetting queue %s",
	11: "[nuqs gtq] Applying %d pending update(s) on top of %s",
	12: "[nuqs gtq] Flushing queue %O with options %O",
	13: "[nuqs dq] Flushing debounce queue %O",
	14: "[nuqs dq] Reset debounce queue %O",
	15: "[nuqs dqc] Creating debounce queue for `%s`",
	16: "[nuqs dqc] Cleaning up empty queue for `%s`",
	17: "[nuqs dqc] Enqueueing debounce update %O",
	18: "[nuqs dqc] Aborting debounce queue %s=%s",
	19: "[nuqs] Aborting queues",
	20: "[nuqs %s] Updating url: %s",
	21: "[nuqs %s] Patching history (%s adapter)",
	22: "[nuqs `%s`] no change, returning previous: %O",
	23: `[nuqs \`%s\`] subbed search params change
  from %O
  to   %O`,
	24: "[nuqs] Error while parsing value `%s`: %O",
	25: "[nuqs] Error while parsing value `%s`: %O (for key `%s`)"
};
function sprintf(base, ...args) {
	return base.replace(/%[sfdO]/g, (match) => {
		const arg = args.shift();
		return match === "%O" && arg ? JSON.stringify(arg).replace(/"([^"]+)":/g, "$1:") : String(arg);
	});
}
//#endregion
//#region src/debug.ts
function installDebugSink() {
	setDebugSink((code, args, isWarn) => {
		const message = debugMessages[code];
		if (isWarn) {
			console.warn(message, ...args);
			return;
		}
		const formatted = sprintf(message, ...args);
		performance.mark(formatted);
		try {
			console.log(message, ...args);
		} catch {
			console.log(formatted);
		}
	});
}
if (isDebugFlagSet()) installDebugSink();
//#endregion
export {};

//# sourceMappingURL=debug.js.map