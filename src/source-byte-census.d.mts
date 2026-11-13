/** Complete stable manifest; null means the census could not establish coverage. */
export function captureSourceByteManifest(root: string): Array<{ path: string; sha256: string }> | null;
