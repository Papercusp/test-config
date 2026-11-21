type Manifest = Array<{ path: string; sha256: string }>;
export function hashSourceFiles(root: string, files: string[]): Manifest;
export function readSourceBytePass(root: string): Manifest;
export function readSourceBytePass<T>(root: string, readFiles: (root: string, files: string[]) => T): T;
export function confirmSourceByteManifest(before: Manifest, after: Manifest): Manifest | null;
/** Complete stable manifest; null means the census could not establish coverage. */
export function captureSourceByteManifest(root: string): Manifest | null;
