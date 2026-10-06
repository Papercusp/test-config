import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { satisfies } from '../../../scripts/check-peer-dep-conflicts.mjs';

// Optional Vitest plugins become peer requirements when the root installs them.
// A workspace-local runner must therefore use the same toolchain as the host.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const hostRequire = createRequire(join(root, 'package.json'));
const hostVersion = JSON.parse(readFileSync(hostRequire.resolve('vitest/package.json'), 'utf8')).version as string;

describe('installed workspace Vitest toolchain compatibility', () => {
  it.each(['libs/host-platform', 'libs/generic/resumable-download'])('%s resolves the host runner and compatible installed plugins', (workspace) => {
    const workspaceRequire = createRequire(join(root, workspace, 'package.json'));
    const runnerPath = workspaceRequire.resolve('vitest/package.json');
    const runner = JSON.parse(readFileSync(runnerPath, 'utf8')) as {
      version: string;
      peerDependencies: Record<string, string>;
    };
    const runnerRequire = createRequire(runnerPath);
    expect(runner.version).toBe(hostVersion);
    for (const plugin of ['@vitest/ui', '@vitest/coverage-v8']) {
      const installed = JSON.parse(readFileSync(runnerRequire.resolve(`${plugin}/package.json`), 'utf8')) as {
        version: string;
        peerDependencies: Record<string, string>;
      };
      expect(satisfies(installed.version, runner.peerDependencies[plugin]), `${workspace}: ${plugin} must satisfy runner ${runner.version}`).toBe(true);
      expect(satisfies(runner.version, installed.peerDependencies.vitest), `${workspace}: runner must satisfy ${plugin} ${installed.version}`).toBe(true);
    }
  });
});
