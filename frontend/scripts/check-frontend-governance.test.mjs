import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { withGovernanceFixture } from './governance-test-helpers.mjs';
import { createHealthBaseline } from './frontend-health-baseline.mjs';
import { collectFrontendHealth } from './frontend-health-metrics.mjs';
import { runFrontendGovernance } from './check-frontend-governance.mjs';


const FIXTURE_COMMIT = '0123456789abcdef0123456789abcdef01234567';


async function withGovernanceArtifacts(result, callback, { mutateHealth } = {}) {
  await withGovernanceFixture(async (fixture) => {
    const directory = await mkdtemp(path.join(tmpdir(), 'culina-governance-ci-'));
    try {
      const health = await collectFrontendHealth({
        rootDir: fixture.rootDir,
        sourceDir: fixture.sourceDir,
        commit: FIXTURE_COMMIT,
      });
      const baseline = createHealthBaseline(health);
      const currentHealth = mutateHealth ? mutateHealth(structuredClone(health)) : health;
      const paths = {
        health: path.join(directory, 'frontend-health.json'),
        baseline: path.join(directory, 'frontend-health-baseline.json'),
        manifest: path.join(directory, 'frontend-health-manifest.json'),
        bundle: path.join(directory, 'bundle-result.json'),
      };
      await Promise.all([
        writeFile(paths.health, JSON.stringify(currentHealth), 'utf8'),
        writeFile(paths.baseline, JSON.stringify(baseline), 'utf8'),
        writeFile(paths.manifest, JSON.stringify({
          version: 1,
          entries: { main: {} },
          assets: {},
          manifestErrors: [],
        }), 'utf8'),
        writeFile(paths.bundle, JSON.stringify(result), 'utf8'),
      ]);
      await callback(paths);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });
}


describe('frontend governance aggregator', () => {
  it('validates success and failure fixture outcomes through the CLI', () => {
    const result = spawnSync(process.execPath, [
      path.resolve(process.cwd(), 'scripts', 'check-frontend-governance.mjs'),
      '--fixtures',
      path.resolve(process.cwd(), 'scripts', 'fixtures', 'governance-ci'),
    ], { encoding: 'utf8' });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('failure: expected=1 actual=1');
    expect(result.stdout).toContain('success: expected=0 actual=0');
  });

  it('fails when one child result fails', async () => {
    await withGovernanceArtifacts({ exitCode: 1, violations: [{ entry: 'main' }] }, async (paths) => {
      const result = await runFrontendGovernance({
        healthPath: paths.health,
        manifestPath: paths.manifest,
        resultPaths: { bundle: paths.bundle },
        mode: 'ratchet',
      });

      expect(result.exitCode).toBe(1);
      expect(result.violations).toContainEqual(expect.objectContaining({ check: 'bundle' }));
    });
  });

  it('fails when frontend health adds an important above baseline', async () => {
    await withGovernanceArtifacts(
      { exitCode: 0, violations: [], manifestErrors: [] },
      async (paths) => {
        const result = await runFrontendGovernance({
          healthPath: paths.health,
          baselinePath: paths.baseline,
          manifestPath: paths.manifest,
          resultPaths: { bundle: paths.bundle },
          mode: 'ratchet',
        });

        expect(result.exitCode).toBe(1);
        expect(result.violations).toContainEqual(expect.objectContaining({ check: 'health' }));
      },
      {
        mutateHealth: (health) => {
          health.css.important += 1;
          health.css.hits.push({
            file: 'src/new.css',
            line: 1,
            column: 1,
            metric: 'important',
            value: '!important',
          });
          return health;
        },
      },
    );
  });

  it('fails when a child result reports a non-success status', async () => {
    await withGovernanceArtifacts({
      status: 'failure',
      exitCode: 0,
      violations: [],
      manifestErrors: [],
    }, async (paths) => {
      const result = await runFrontendGovernance({
        healthPath: paths.health,
        manifestPath: paths.manifest,
        resultPaths: { style: paths.bundle },
        mode: 'ratchet',
      });

      expect(result.exitCode).toBe(1);
      expect(result.violations).toContainEqual(expect.objectContaining({ check: 'style' }));
    });
  });

  it('passes only when every supplied artifact is valid and successful', async () => {
    await withGovernanceArtifacts({ exitCode: 0, violations: [], manifestErrors: [] }, async (paths) => {
      const result = await runFrontendGovernance({
        healthPath: paths.health,
        manifestPath: paths.manifest,
        resultPaths: { bundle: paths.bundle },
        mode: 'ratchet',
      });

      expect(result).toMatchObject({ exitCode: 0, violations: [] });
      expect(result.checks).toEqual(expect.arrayContaining([
        { name: 'health', status: 'success' },
        { name: 'manifest', status: 'success' },
        { name: 'bundle', status: 'success' },
      ]));
    });
  });

  it('keeps the workflow artifact path and existing frontend checks under contract', async () => {
    const workflow = await readFile(
      path.resolve(process.cwd(), '..', '.github', 'workflows', 'quality-gates.yml'),
      'utf8',
    );

    for (const required of [
      'frontend-governance',
      'Frontend Governance',
      'health:report',
      'build:manifest',
      'check:governance',
      'frontend-health.json',
      'frontend-health-manifest.json',
      '.artifacts/frontend-health-manifest.json',
      'mkdir -p .artifacts',
      'cp frontend/dist/.vite/frontend-health-manifest.json .artifacts/frontend-health-manifest.json',
      'if: always()',
      'frontend-vitest-shard',
      'frontend-style-drift',
      'frontend-build',
      'frontend-e2e-p0',
    ]) {
      expect(workflow).toContain(required);
    }
  });
});
