export interface TrackedFileCoverage {
  declared: string[]; scanned: string[]; unscanned: string[];
  unscannedPresent: string[]; unscannedAbsent: string[];
}
export function declaredSubmodules(cwd?: string): string[];
export function listTrackedFiles(cwd?: string): TrackedFileCoverage & { files: string[] };
export function listFilesIncludingUntracked(cwd?: string): TrackedFileCoverage & { files: string[] };
export function presentOnDisk(files: string[], cwd?: string): string[];
export function coverageOf(files: string[], cwd?: string): TrackedFileCoverage;
export function describeUnscanned(scan: string[] | (Partial<TrackedFileCoverage> & { unscanned: string[] }), cwd?: string): string;
