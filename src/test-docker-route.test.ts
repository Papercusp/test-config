import { describe, expect, it } from 'vitest';
import { assertIsolatedTestDockerStorage, configureTestDockerHost,
  HOST_TEST_DOCKER_SOCKET, TEST_DOCKER_ISOLATION_REQUIRED } from './test-docker-route.ts';

describe('maintained host test Docker route (WI-6554700010046431)', () => {
  const GiB = 1024 ** 3;

  it('selects the installed isolated engine and requires storage admission', () => {
    const env: NodeJS.ProcessEnv = {};
    configureTestDockerHost(env, { platform: 'linux', socketExists: path => path === HOST_TEST_DOCKER_SOCKET });
    expect(env).toEqual({ DOCKER_HOST: `unix://${HOST_TEST_DOCKER_SOCKET}`,
      [TEST_DOCKER_ISOLATION_REQUIRED]: '1' });
  });

  it.each(['unix:///run/custom.sock', 'tcp://test-daemon:2376'])('preserves explicit endpoint %s', dockerHost => {
    const env: NodeJS.ProcessEnv = { DOCKER_HOST: dockerHost };
    configureTestDockerHost(env, { platform: 'linux', socketExists: () => true });
    expect(env).toEqual({ DOCKER_HOST: dockerHost });
  });

  it('preserves an explicit context and portable hosts without the local engine', () => {
    for (const env of [{ DOCKER_CONTEXT: 'my-test-engine' }, {}]) {
      const before = { ...env };
      configureTestDockerHost(env, { platform: 'linux', socketExists: () => false });
      expect(env).toEqual(before);
    }
    const env = {};
    configureTestDockerHost(env, { platform: 'darwin', socketExists: () => true });
    expect(env).toEqual({});
  });

  it('refuses an empty explicit endpoint instead of falling back to main', () => {
    expect(() => configureTestDockerHost({ DOCKER_HOST: ' ' },
      { platform: 'linux', socketExists: () => true })).toThrow('must not be blank');
  });

  it('does not fall back when required isolation loses its selected engine', () => {
    const env = { [TEST_DOCKER_ISOLATION_REQUIRED]: '1' };
    expect(() => configureTestDockerHost(env, { platform: 'linux', socketExists: () => false }))
      .toThrow('isolation required but no isolated engine');
    expect(env).not.toHaveProperty('DOCKER_HOST');
  });

  const selected = { DOCKER_HOST: 'unix:///run/custom.sock', [TEST_DOCKER_ISOLATION_REQUIRED]: '1' };
  const info = async () => ({ ID: 'selected-daemon', DockerRootDir: '/mnt/test/docker' });

  it('records the selected daemon, distinct filesystem devices, and verified headroom', async () => {
    await expect(assertIsolatedTestDockerStorage(
      info,
      selected,
      async path => path === '/' ? 1 : 2,
      async () => ({ blocks: 20 * GiB / 1024, bavail: 5 * GiB / 1024, bsize: 1024 }),
    ))
      .resolves.toEqual({ dockerHost: selected.DOCKER_HOST, daemonId: 'selected-daemon',
        dataRoot: '/mnt/test/docker', dataDevice: 2, hostDevice: 1,
        dataRootTotalBytes: 20 * GiB, dataRootFreeBytes: 5 * GiB, isolated: true });
  });

  it('refuses low data-root headroom before allocating a PostgreSQL container', async () => {
    const measured: string[] = [];
    await expect(assertIsolatedTestDockerStorage(
      info,
      selected,
      async path => path === '/' ? 1 : 2,
      async path => {
        measured.push(path);
        return { blocks: 20 * GiB / 1024, bavail: GiB / 1024, bsize: 1024 };
      },
    )).rejects.toThrow(/TEST DOCKER STORAGE LOW.*Refusing PostgreSQL container allocation before launch/);
    expect(measured).toEqual(['/mnt/test/docker']);
  });

  it('fails closed when selected data-root capacity cannot be read', async () => {
    await expect(assertIsolatedTestDockerStorage(
      info,
      selected,
      async path => path === '/' ? 1 : 2,
      async () => { throw new Error('statfs unavailable'); },
    )).rejects.toThrow(/TEST DOCKER STORAGE UNKNOWN.*headroom/);
  });

  it('rejects a different directory on the same filesystem before allocation', async () => {
    await expect(assertIsolatedTestDockerStorage(info, selected, async () => 1))
      .rejects.toThrow(/NOT ISOLATED.*No PostgreSQL container was created/);
  });

  it('propagates a selected engine failure without trying a default daemon', async () => {
    let reads = 0;
    await expect(assertIsolatedTestDockerStorage(async () => {
      reads++;
      throw new Error('selected engine unavailable');
    }, selected)).rejects.toThrow('selected engine unavailable');
    expect(reads).toBe(1);
  });

  it('refuses unknown storage and nonlocal endpoints when isolation is required', async () => {
    await expect(assertIsolatedTestDockerStorage(async () => ({}), selected)).rejects.toThrow('STORAGE UNKNOWN');
    await expect(assertIsolatedTestDockerStorage(info,
      { ...selected, DOCKER_HOST: 'tcp://remote:2376' })).rejects.toThrow('explicit local Unix');
    await expect(assertIsolatedTestDockerStorage(info, selected, async () => NaN)).rejects.toThrow('STORAGE UNKNOWN');
  });

  it('does not inspect local storage for a portable caller-selected route', async () => {
    await expect(assertIsolatedTestDockerStorage(async () => {
      throw new Error('must not query this daemon');
    }, { DOCKER_HOST: 'tcp://remote:2376' })).resolves.toBeNull();
  });
});
