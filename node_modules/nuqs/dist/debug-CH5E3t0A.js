//#region src/lib/debug.ts
let sink = null;
/**
* Install (or remove, with `null`) the function that renders debug logs.
*/
function setDebugSink(newSink) {
	sink = newSink;
}
function debug(code, ...args) {
	sink?.(code, args);
}
function warn(code, ...args) {
	sink?.(code, args, true);
}
function isDebugFlagSet() {
	if (typeof window === "undefined") return typeof process !== "undefined" && (process.env.DEBUG || "").includes("nuqs");
	try {
		const test = "nuqs-localStorage-test";
		if (typeof localStorage === "undefined") return false;
		localStorage.setItem(test, test);
		const isStorageAvailable = localStorage.getItem(test) === test;
		localStorage.removeItem(test);
		return isStorageAvailable && (localStorage.getItem("debug") || "").includes("nuqs");
	} catch {
		return false;
	}
}
//#endregion
export { warn as i, isDebugFlagSet as n, setDebugSink as r, debug as t };

//# sourceMappingURL=debug-CH5E3t0A.js.map