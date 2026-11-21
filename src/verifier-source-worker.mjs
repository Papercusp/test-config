/** The shared verifier uses only Node builtins and Node 25's native TS loader. */
import { parentPort, workerData } from 'node:worker_threads';
import { readVerifierComparisonSourcesSync, readVerifierSourceReceiptSync } from './verifier-source.ts';

try {
  const progress = record => parentPort.postMessage({ progress: record });
  const receipt = workerData.definition
    ? readVerifierComparisonSourcesSync(workerData.root, workerData.definition, progress)
    : readVerifierSourceReceiptSync(workerData.root, workerData.receiptPath, { mutation: workerData.mutation, progress });
  parentPort.postMessage({ receipt });
} catch (error) {
  parentPort.postMessage({ error: error instanceof Error ? error.message : String(error) });
}
