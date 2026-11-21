import { realpathSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { Worker, parentPort, workerData } from 'node:worker_threads';
import { confirmSourceByteManifest, hashSourceFiles, readSourceBytePass } from './source-byte-census.mjs';

async function hashInWorkers(root, files) {
  // Limit the workers, never the number of paths. Small observations stay
  // on this dedicated worker and avoid another thread startup.
  const count = Math.min(4, availableParallelism(), Math.ceil(files.length / 512));
  if (count <= 1) return hashSourceFiles(root, files);
  const width = Math.ceil(files.length / count);
  const workers = [];
  try {
    const parts = await Promise.all(Array.from({ length: count }, (_, i) => new Promise((resolve, reject) => {
      const paths = files.slice(i * width, (i + 1) * width);
      const worker = new Worker(new URL(import.meta.url), { workerData: { root, paths }, execArgv: [] });
      workers.push(worker);
      let entries;
      worker.once('message', message => { entries = message; });
      worker.once('error', reject);
      worker.once('exit', code => {
        if (code === 0 && Array.isArray(entries) && entries.length === paths.length) resolve(entries);
        else reject(new Error('source-byte-worker-incomplete'));
      });
    })));
    return parts.flat();
  } finally {
    // The owning worker does not report an incomplete pass while siblings
    // are still reading. Terminating the owner also retires its Node subworkers.
    await Promise.all(workers.map(worker => worker.terminate()));
  }
}

if (Array.isArray(workerData?.paths)) {
  parentPort.postMessage(hashSourceFiles(workerData.root, workerData.paths));
} else {
  let manifest = null;
  try {
    const root = realpathSync.native(workerData.root);
    const before = await readSourceBytePass(root, hashInWorkers);
    const after = await readSourceBytePass(root, hashInWorkers);
    manifest = confirmSourceByteManifest(before, after);
  } catch {
    // Missing, changed, or unreadable inputs cannot establish source identity.
  }
  parentPort?.postMessage({ type: 'result', manifest });
}
