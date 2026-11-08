import { existsSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';

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
 * daemon's actual data-root and compare filesystem devices before container
 * creation can block in overlay unmount -> ovl_sync_fs -> root writeback.
 */
export async function assertIsolatedTestDockerStorage(
  readInfo: () => Promise<{ ID?: string; DockerRootDir?: string }>,
  env: NodeJS.ProcessEnv = process.env,
  deviceFor: (path: string) => Promise<number> = async path => (await stat(path)).dev,
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
  return { dockerHost, daemonId: info.ID, dataRoot, dataDevice, hostDevice, isolated: true as const };
}
