import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

export const ACCEPTANCE_SERVICES = [
  'postgres',
  'typesense',
  'redis',
  'mediamtx',
  'api',
  'web',
  'worker',
] as const;

export type AcceptanceService = (typeof ACCEPTANCE_SERVICES)[number];

export interface AcceptanceProvisionRequest {
  runId: string;
  requestedSha: string;
  repositoryRoot: string;
}

export interface AcceptanceCommandOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

export interface AcceptanceCommandResult {
  stdout: string;
  stderr: string;
}

export interface AcceptanceCommandRunner {
  run(command: string, args: readonly string[], options: AcceptanceCommandOptions): Promise<AcceptanceCommandResult>;
}

export interface AcceptanceImageEvidence {
  service: AcceptanceService;
  repository: string;
  tag: string;
  digest: string;
}

export interface AcceptanceHealthEvidence {
  service: AcceptanceService;
  state: string;
  health: string;
}

export interface AcceptanceEnvironmentEvidence {
  runId: string;
  projectName: string;
  requestedSha: string;
  deployedSha: string;
  imageDigests: AcceptanceImageEvidence[];
  healthChecks: AcceptanceHealthEvidence[];
  apiHealth: { status: string; service: string; sha: string };
  workerHealth: { status: string; service: string; sha: string; runId: string };
}

export interface AcceptanceEnvironmentHandle extends AcceptanceEnvironmentEvidence {
  teardown(): Promise<void>;
}

export type AcceptanceProvisioningStage =
  | 'validate'
  | 'same-sha'
  | 'compose-config'
  | 'compose-up'
  | 'health'
  | 'teardown';

export class AcceptanceEnvironmentBlockedError extends Error {
  readonly stage: AcceptanceProvisioningStage;
  readonly blockedReason: string;
  readonly cleanupAttempted: boolean;

  constructor(
    stage: AcceptanceProvisioningStage,
    blockedReason: string,
    options: { cause?: unknown; cleanupAttempted?: boolean } = {},
  ) {
    super(`Acceptance environment blocked during ${stage}: ${blockedReason}`, { cause: options.cause });
    this.name = 'AcceptanceEnvironmentBlockedError';
    this.stage = stage;
    this.blockedReason = blockedReason;
    this.cleanupAttempted = options.cleanupAttempted ?? false;
  }
}

const SHA_PATTERN = /^[0-9a-f]{40}$/;
const RUN_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const PROD_MARKERS = [
  /sidestage\.buyrestart\.com/i,
  /\/opt\/SideStage(?:\/|$)/,
  /traefik\.docker\.network\s*[:=]\s*coolify/i,
  /external:\s*true/i,
  /network_mode:\s*host/i,
];

function assertSafeRequest(request: AcceptanceProvisionRequest): void {
  if (!RUN_ID_PATTERN.test(request.runId)) {
    throw new AcceptanceEnvironmentBlockedError('validate', 'runId must be a bounded lowercase identifier');
  }
  if (!SHA_PATTERN.test(request.requestedSha)) {
    throw new AcceptanceEnvironmentBlockedError('validate', 'requestedSha must be a full lowercase git SHA');
  }
  if (!resolve(request.repositoryRoot).startsWith('/')) {
    throw new AcceptanceEnvironmentBlockedError('validate', 'repositoryRoot must resolve to an absolute path');
  }
  if (/^\/opt\/SideStage(?:\/|$)/i.test(resolve(request.repositoryRoot))) {
    throw new AcceptanceEnvironmentBlockedError('validate', 'the production checkout can never be an acceptance build context');
  }
}

function parseJsonRows(output: string, label: string): Record<string, unknown>[] {
  const source = output.trim();
  if (!source) throw new Error(`${label} returned no rows`);
  try {
    const parsed = JSON.parse(source) as unknown;
    if (Array.isArray(parsed)) return parsed as Record<string, unknown>[];
    if (parsed && typeof parsed === 'object') return [parsed as Record<string, unknown>];
  } catch {
    const rows = source.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
    if (rows.length > 0) return rows;
  }
  throw new Error(`${label} did not return JSON objects`);
}

function field(row: Record<string, unknown>, ...names: string[]): string {
  for (const name of names) {
    const value = row[name];
    if (typeof value === 'string') return value;
  }
  return '';
}

function asService(value: string): AcceptanceService | null {
  return ACCEPTANCE_SERVICES.includes(value as AcceptanceService) ? value as AcceptanceService : null;
}

export function parseAcceptanceImages(output: string): AcceptanceImageEvidence[] {
  const images = parseJsonRows(output, 'docker compose images').map((row) => {
    const service = asService(field(row, 'Service', 'service'));
    const digest = field(row, 'ID', 'Id', 'id', 'Digest', 'digest');
    if (!service) throw new Error(`docker compose images returned unknown service ${field(row, 'Service', 'service')}`);
    if (!/^sha256:[0-9a-f]{64}$/.test(digest)) throw new Error(`service ${service} has no content-addressed image digest`);
    return {
      service,
      repository: field(row, 'Repository', 'repository'),
      tag: field(row, 'Tag', 'tag'),
      digest,
    };
  });
  const present = new Set(images.map((entry) => entry.service));
  for (const service of ACCEPTANCE_SERVICES) {
    if (!present.has(service)) throw new Error(`docker compose images omitted ${service}`);
  }
  return images;
}

export function parseAcceptanceHealth(output: string): AcceptanceHealthEvidence[] {
  const health = parseJsonRows(output, 'docker compose ps').map((row) => {
    const service = asService(field(row, 'Service', 'service'));
    if (!service) throw new Error(`docker compose ps returned unknown service ${field(row, 'Service', 'service')}`);
    const state = field(row, 'State', 'state').toLowerCase();
    const probe = field(row, 'Health', 'health').toLowerCase() || 'running';
    if (state !== 'running') throw new Error(`service ${service} is ${state || 'unknown'}, not running`);
    if (!['healthy', 'running'].includes(probe)) throw new Error(`service ${service} health is ${probe}`);
    return { service, state, health: probe };
  });
  const present = new Set(health.map((entry) => entry.service));
  for (const service of ACCEPTANCE_SERVICES) {
    if (!present.has(service)) throw new Error(`docker compose ps omitted ${service}`);
  }
  return health;
}

class SpawnCommandRunner implements AcceptanceCommandRunner {
  async run(
    command: string,
    args: readonly string[],
    options: AcceptanceCommandOptions,
  ): Promise<AcceptanceCommandResult> {
    return new Promise((resolvePromise, reject) => {
      const child = spawn(command, [...args], {
        cwd: options.cwd,
        env: options.env ?? process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      const append = (current: string, chunk: Buffer): string => {
        const next = current + chunk.toString('utf8');
        if (next.length > 2_000_000) {
          child.kill('SIGKILL');
          reject(new Error(`${command} output exceeded 2 MB`));
        }
        return next;
      };
      child.stdout.on('data', (chunk: Buffer) => { stdout = append(stdout, chunk); });
      child.stderr.on('data', (chunk: Buffer) => { stderr = append(stderr, chunk); });
      const timeout = setTimeout(() => {
        child.kill('SIGTERM');
        reject(new Error(`${command} timed out after ${options.timeoutMs ?? 600_000}ms`));
      }, options.timeoutMs ?? 600_000);
      child.once('error', (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      child.once('close', (code) => {
        clearTimeout(timeout);
        if (code === 0) resolvePromise({ stdout, stderr });
        else reject(new Error(`${command} exited ${code}: ${stderr.trim() || stdout.trim()}`));
      });
    });
  }
}

function safeEnvironment(request: AcceptanceProvisionRequest, projectName: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    COMPOSE_PROJECT_NAME: projectName,
    SIDESTAGE_SHA: request.requestedSha,
    ACCEPTANCE_RUN_ID: request.runId,
    NODE_ENV: 'test',
    POSTGRES_DB: `acceptance_${request.runId.replaceAll('-', '_')}`,
    POSTGRES_USER: 'sidestage_acceptance',
    POSTGRES_PASSWORD: `acceptance-${request.runId}-postgres`,
    TYPESENSE_API_KEY: `acceptance-${request.runId}-typesense`,
  };
}

function parseHealthPayload(
  output: string,
  expected: { service: string; sha: string; runId?: string },
): Record<string, string> {
  const payload = JSON.parse(output.trim()) as Record<string, unknown>;
  if (payload.status !== 'ok' || payload.service !== expected.service || payload.sha !== expected.sha) {
    throw new Error(`${expected.service} health payload did not prove requested SHA ${expected.sha}`);
  }
  if (expected.runId !== undefined && payload.runId !== expected.runId) {
    throw new Error(`${expected.service} health payload did not prove run ${expected.runId}`);
  }
  return payload as Record<string, string>;
}

export class AcceptanceEnvironmentProvisioner {
  readonly #runner: AcceptanceCommandRunner;
  readonly #tornDown = new Set<string>();

  constructor(runner: AcceptanceCommandRunner = new SpawnCommandRunner()) {
    this.#runner = runner;
  }

  async provision(request: AcceptanceProvisionRequest): Promise<AcceptanceEnvironmentHandle> {
    assertSafeRequest(request);
    const repositoryRoot = resolve(request.repositoryRoot);
    const projectName = `sidestage-acceptance-${request.runId}`;
    const env = safeEnvironment(request, projectName);
    const compose = [
      'compose',
      '-p', projectName,
      '-f', 'docker-compose.yml',
      '-f', 'infra/docker-compose.acceptance.yml',
    ] as const;
    const runCompose = (args: readonly string[], timeoutMs?: number) =>
      this.#runner.run('docker', [...compose, ...args], { cwd: repositoryRoot, env, timeoutMs });

    const head = (await this.#runner.run('git', ['rev-parse', 'HEAD'], { cwd: repositoryRoot })).stdout.trim();
    if (head !== request.requestedSha) {
      throw new AcceptanceEnvironmentBlockedError(
        'same-sha',
        `repository HEAD ${head || '(unknown)'} does not match requested SHA ${request.requestedSha}`,
      );
    }

    const rendered = await runCompose(['config']).catch((cause: unknown) => {
      throw new AcceptanceEnvironmentBlockedError('compose-config', 'acceptance Compose config is invalid', { cause });
    });
    for (const marker of PROD_MARKERS) {
      if (marker.test(rendered.stdout)) {
        throw new AcceptanceEnvironmentBlockedError(
          'compose-config',
          `acceptance Compose config contains forbidden production marker ${marker.source}`,
        );
      }
    }

    let cleanupAttempted = false;
    const teardown = async (): Promise<void> => {
      if (this.#tornDown.has(projectName)) return;
      cleanupAttempted = true;
      await runCompose(['down', '--volumes', '--remove-orphans', '--timeout', '10'], 120_000);
      this.#tornDown.add(projectName);
    };

    try {
      await runCompose(['up', '--build', '--wait', '--detach'], 900_000);
      const [imagesOutput, psOutput, apiOutput, workerOutput] = await Promise.all([
        runCompose(['images', '--format', 'json']),
        runCompose(['ps', '--format', 'json']),
        runCompose(['exec', '-T', 'api', 'node', '-e',
          "fetch('http://127.0.0.1:3100/healthz').then(r=>r.text()).then(t=>process.stdout.write(t))"]),
        runCompose(['exec', '-T', 'worker', 'node', '-e',
          "fetch('http://127.0.0.1:3101/healthz').then(r=>r.text()).then(t=>process.stdout.write(t))"]),
      ]);
      const imageDigests = parseAcceptanceImages(imagesOutput.stdout);
      const healthChecks = parseAcceptanceHealth(psOutput.stdout);
      const apiHealth = parseHealthPayload(apiOutput.stdout, {
        service: 'sidestage-api',
        sha: request.requestedSha,
      });
      const workerHealth = parseHealthPayload(workerOutput.stdout, {
        service: 'sidestage-acceptance-worker',
        sha: request.requestedSha,
        runId: request.runId,
      });
      return {
        runId: request.runId,
        projectName,
        requestedSha: request.requestedSha,
        deployedSha: apiHealth.sha,
        imageDigests,
        healthChecks,
        apiHealth: apiHealth as AcceptanceEnvironmentEvidence['apiHealth'],
        workerHealth: workerHealth as AcceptanceEnvironmentEvidence['workerHealth'],
        teardown,
      };
    } catch (cause) {
      try {
        await teardown();
      } catch (cleanupCause) {
        throw new AcceptanceEnvironmentBlockedError(
          'teardown',
          `provisioning failed and cleanup also failed: ${cleanupCause instanceof Error ? cleanupCause.message : String(cleanupCause)}`,
          { cause, cleanupAttempted: true },
        );
      }
      throw new AcceptanceEnvironmentBlockedError(
        'compose-up',
        cause instanceof Error ? cause.message : String(cause),
        { cause, cleanupAttempted },
      );
    }
  }
}
