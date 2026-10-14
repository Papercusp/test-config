/** The shared verifier uses only Node builtins and Node 25's native TS loader. */
import { parentPort, workerData } from 'node:worker_threads';
import { readVerifierSourceReceiptSync } from './verifier-source.ts';

try {
  parentPort.postMessage({ receipt: readVerifierSourceReceiptSync(workerData.root, workerData.receiptPath) });
} catch (error) {
  parentPort.postMessage({ error: error instanceof Error ? error.message : String(error) });
}
