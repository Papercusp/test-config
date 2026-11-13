import { parentPort, workerData } from 'node:worker_threads';
import { captureSourceByteManifest } from './source-byte-census.mjs';

const manifest = typeof workerData?.root === 'string'
  ? captureSourceByteManifest(workerData.root)
  : null;
parentPort?.postMessage({ type: 'result', manifest });
