import { describe, expect, it } from 'vitest';
import {
  ACCEPTANCE_SERVICES,
  AcceptanceEnvironmentBlockedError,
  AcceptanceEnvironmentProvisioner,
  type AcceptanceCommandOptions,
  type AcceptanceCommandResult,
  type AcceptanceCommandRunner,
  parseAcceptanceHealth,
  parseAcceptanceImages,
} from './acceptance-environment';

const SHA = 'a'.repeat(40);

class FakeRunner implements AcceptanceCommandRunner {
  readonly calls: { command: string; args: readonly string[]; options: AcceptanceCommandOptions }[] = [];
  failUp = false;
  config = 'services:\n  api: {}\n';

  async run(
    command: string,
    args: readonly string[],
    options: AcceptanceCommandOptions,
  ): Promise<AcceptanceCommandResult> {
    this.calls.push({ command, args, options });
    const joined = [command, ...args].join(' ');
    if (joined === 'git rev-parse HEAD') return { stdout: `${SHA}\n`, stderr: '' };
    if (joined.endsWith(' config')) return { stdout: this.config, stderr: '' };
    if (joined.includes(' up --build --wait --detach')) {
      if (this.failUp) throw new Error('typesense failed its health check');
      return { stdout: 'started', stderr: '' };
    }
    if (joined.includes(' images --format json')) return { stdout: imageRows(), stderr: '' };
    if (joined.includes(' ps --format json')) return { stdout: healthRows(), stderr: '' };
    if (joined.includes("exec -T api node -e")) {
      return { stdout: JSON.stringify({ status: 'ok', service: 'sidestage-api', sha: SHA }), stderr: '' };
    }
    if (joined.includes("exec -T worker node -e")) {
      return {
        stdout: JSON.stringify({ status: 'ok', service: 'sidestage-acceptance-worker', sha: SHA, runId: 'run-1' }),
        stderr: '',
      };
    }
    if (joined.includes(' down --volumes --remove-orphans --timeout 10')) return { stdout: 'removed', stderr: '' };
    throw new Error(`unexpected command: ${joined}`);
  }
}

function imageRows(): string {
  return JSON.stringify(ACCEPTANCE_SERVICES.map((service, index) => ({
    Service: service,
    Repository: `sidestage-${service}`,
    Tag: SHA,
    ID: `sha256:${String(index + 1).repeat(64)}`,
  })));
}

function healthRows(): string {
  return ACCEPTANCE_SERVICES.map((service) => JSON.stringify({
    Service: service,
    State: 'running',
    Health: ['api', 'web', 'worker', 'postgres'].includes(service) ? 'healthy' : '',
  })).join('\n');
}

describe('acceptance environment evidence parsers', () => {
  it('requires one content-addressed image for every service', () => {
    expect(parseAcceptanceImages(imageRows())).toHaveLength(ACCEPTANCE_SERVICES.length);
    expect(() => parseAcceptanceImages(JSON.stringify([{ Service: 'api', ID: 'short-id' }]))).toThrow(
      /content-addressed image digest/,
    );
  });

  it('requires every service to be running and healthy when it declares a health check', () => {
    expect(parseAcceptanceHealth(healthRows())).toHaveLength(ACCEPTANCE_SERVICES.length);
    expect(() => parseAcceptanceHealth(healthRows().replace('"State":"running"', '"State":"exited"'))).toThrow(
      /not running/,
    );
  });
});

describe('AcceptanceEnvironmentProvisioner', () => {
  it('boots the exact requested SHA and records image plus health evidence', async () => {
    const runner = new FakeRunner();
    const provisioner = new AcceptanceEnvironmentProvisioner(runner);
    const environment = await provisioner.provision({
      runId: 'run-1',
      requestedSha: SHA,
      repositoryRoot: '/workspace/sidestage',
    });

    expect(environment).toMatchObject({
      projectName: 'sidestage-acceptance-run-1',
      requestedSha: SHA,
      deployedSha: SHA,
    });
    expect(environment.imageDigests).toHaveLength(7);
    expect(environment.healthChecks).toHaveLength(7);
    expect(runner.calls.find((call) => call.args.includes('up'))?.options.env).toMatchObject({
      COMPOSE_PROJECT_NAME: 'sidestage-acceptance-run-1',
      SIDESTAGE_SHA: SHA,
      NODE_ENV: 'test',
    });

    await environment.teardown();
    await environment.teardown();
    expect(runner.calls.filter((call) => call.args.includes('down'))).toHaveLength(1);
  });

  it('blocks a different checked-out SHA before Docker is touched', async () => {
    const runner = new FakeRunner();
    runner.run = async function (command, args, options) {
      this.calls.push({ command, args, options });
      return { stdout: `${'b'.repeat(40)}\n`, stderr: '' };
    };
    await expect(new AcceptanceEnvironmentProvisioner(runner).provision({
      runId: 'run-1', requestedSha: SHA, repositoryRoot: '/workspace/sidestage',
    })).rejects.toMatchObject({ stage: 'same-sha' });
    expect(runner.calls.every((call) => call.command === 'git')).toBe(true);
  });

  it('rejects the production checkout and production markers in rendered Compose', async () => {
    await expect(new AcceptanceEnvironmentProvisioner(new FakeRunner()).provision({
      runId: 'run-1', requestedSha: SHA, repositoryRoot: '/opt/SideStage',
    })).rejects.toMatchObject({ stage: 'validate' });

    const runner = new FakeRunner();
    runner.config = 'services:\n  api:\n    environment:\n      URL: https://sidestage.buyrestart.com\n';
    await expect(new AcceptanceEnvironmentProvisioner(runner).provision({
      runId: 'run-1', requestedSha: SHA, repositoryRoot: '/workspace/sidestage',
    })).rejects.toMatchObject({ stage: 'compose-config' });
  });

  it('turns a dependency failure into blocked evidence only after teardown', async () => {
    const runner = new FakeRunner();
    runner.failUp = true;
    let error: unknown;
    try {
      await new AcceptanceEnvironmentProvisioner(runner).provision({
        runId: 'run-1', requestedSha: SHA, repositoryRoot: '/workspace/sidestage',
      });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(AcceptanceEnvironmentBlockedError);
    expect(error).toMatchObject({ stage: 'compose-up', cleanupAttempted: true });
    expect(runner.calls.some((call) => call.args.includes('down'))).toBe(true);
  });
});
