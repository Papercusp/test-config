import { existsSync } from 'node:fs';
import { stat, statfs } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { tmpdirHasCriticalHeadroom, type TmpdirStatfs } from './tmpdir-guard.ts';

export const HOST_TEST_DOCKER_SOCKET = '/run/docker-bench.sock';
export const TEST_DOCKER_ISOLATION_REQUIRED = 'PAPERCUSP_TEST_DOCKER_ISOLATION_REQUIRED';

/** Reuse this host's maintained isolated engine before testcontainers caches a
 * client. Explicit endpoints/contexts win; hosts without that engine keep their
 * existing route. Once isolation is selected, an unavailable engine must fail
 * rather than silently allocate on the shared main daemon (WI-6554700010046431).
 */
export function configureTestDockerHost(
  env: NodeJS.ProcessEnv = process.env,
  deps: { platform?: NodeJS.Platform; socketExists?: (path: string) => boolean } = {},
): void {
  if (env.DOCKER_HOST !== undefined) {
    if (!env.DOCKER_HOST.trim()) throw new Error('Test Docker endpoint DOCKER_HOST must not be blank');
    return;
  }
  if (env.DOCKER_CONTEXT?.trim()) {
    if (env[TEST_DOCKER_ISOLATION_REQUIRED] === '1') {
      throw new Error('Test Docker isolation requires an explicit local DOCKER_HOST');
    }
    return;
  }
  if ((deps.platform ?? process.platform) === 'linux'
      && (deps.socketExists ?? existsSync)(HOST_TEST_DOCKER_SOCKET)) {
    env.DOCKER_HOST = `unix://${HOST_TEST_DOCKER_SOCKET}`;
    env[TEST_DOCKER_ISOLATION_REQUIRED] = '1';
    return;
  }
  if (env[TEST_DOCKER_ISOLATION_REQUIRED] === '1') {
    throw new Error('Test Docker isolation required but no isolated engine is selected; set DOCKER_HOST');
  }
}

/** A different directory on root is not writeback isolation. Read the selected
 * daemon's actual data-root, compare filesystem devices, and verify the shared
 * test headroom floor before container allocation.
 */
export async function assertIsolatedTestDockerStorage(
  readInfo: () => Promise<{ ID?: string; DockerRootDir?: string }>,
  env: NodeJS.ProcessEnv = process.env,
  deviceFor: (path: string) => Promise<number> = async path => (await stat(path)).dev,
  readStorage: (path: string) => Promise<TmpdirStatfs> = path => statfs(path),
) {
  if (env[TEST_DOCKER_ISOLATION_REQUIRED] !== '1') return null;
  const dockerHost = env.DOCKER_HOST;
  if (!dockerHost || !/^unix:\/\/\/[^\s?#]+$/.test(dockerHost)) {
    throw new Error('Test Docker isolation requires an explicit local Unix DOCKER_HOST');
  }
  const info = await readInfo();
  const dataRoot = info.DockerRootDir;
  if (!info.ID || !dataRoot || !isAbsolute(dataRoot)) {
    throw new Error('TEST DOCKER STORAGE UNKNOWN: selected daemon must identify its ID and absolute data-root');
  }
  const [dataDevice, hostDevice] = await Promise.all([deviceFor(dataRoot), deviceFor('/')]);
  if (![dataDevice, hostDevice].every(value => Number.isSafeInteger(value) && value >= 0)) {
    throw new Error('TEST DOCKER STORAGE UNKNOWN: cannot establish selected daemon filesystem identity');
  }
  if (dataDevice === hostDevice) {
    throw new Error(`TEST DOCKER STORAGE NOT ISOLATED: ${dataRoot} shares the host root filesystem. `
      + 'Docker overlay unmount can wait on unrelated root writeback; select an engine on a separate filesystem. '
      + 'No PostgreSQL container was created; do not restart or migrate the shared daemon here.');
  }
  let snapshot: TmpdirStatfs;
  try {
    snapshot = await readStorage(dataRoot);
  } catch (cause) {
    throw new Error(`TEST DOCKER STORAGE UNKNOWN: cannot read selected daemon data-root headroom at ${dataRoot}`, { cause });
  }
  const totalBytes = Number(snapshot.blocks) * Number(snapshot.bsize);
  const freeBytes = Number(snapshot.bavail) * Number(snapshot.bsize);
  if (!Number.isSafeInteger(totalBytes) || totalBytes <= 0 ||
      !Number.isSafeInteger(freeBytes) || freeBytes < 0 || freeBytes > totalBytes) {
    throw new Error(`TEST DOCKER STORAGE UNKNOWN: invalid capacity for selected daemon data-root ${dataRoot}`);
  }
  if (!tmpdirHasCriticalHeadroom(dataRoot, env, () => snapshot)) {
    throw new Error(`TEST DOCKER STORAGE LOW: selected daemon data-root ${dataRoot} has ${freeBytes} free bytes `
      + `of ${totalBytes}. Refusing PostgreSQL container allocation before launch; select a private test PG `
      + 'volume with headroom via PAPERCUSP_TEST_PG_ADMIN_URL.');
  }
  return {
    dockerHost,
    daemonId: info.ID,
    dataRoot,
    dataDevice,
    hostDevice,
    dataRootTotalBytes: totalBytes,
    dataRootFreeBytes: freeBytes,
    isolated: true as const,
  };
}
