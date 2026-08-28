import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { describe, expect, it } from 'vitest';

import { withGovernanceFixture } from './governance-test-helpers.mjs';
import { collectFrontendHealth } from './frontend-health-metrics.mjs';
import { createHealthBaseline } from './frontend-health-baseline.mjs';


const SCRIPT_PATH = path.resolve(process.cwd(), 'scripts/check-bundle-budgets.mjs');
const FIXTURE_COMMIT = '0123456789abcdef0123456789abcdef01234567';


function buildManifest({ criticalGzipBytes = 1000, manifestErrors = [] } = {}) {
  return {
    version: 1,
    sourceCommit: FIXTURE_COMMIT,
    entries: {
      main: {
        source: 'src/main.tsx',
        js: ['main-opaque.js'],
        css: ['main-opaque.css'],
        imports: [],
        dynamicImports: [],
        initial: { assets: ['main-opaque.js', 'main-opaque.css'], rawBytes: 2000, gzipBytes: criticalGzipBytes + 100 },
        entryCritical: { assets: ['main-opaque.js'], rawBytes: 1000, gzipBytes: criticalGzipBytes },
        routeTotal: { assets: ['main-opaque.js', 'main-opaque.css'], rawBytes: 2000, gzipBytes: criticalGzipBytes + 100 },
        shared: [],
      },
    },
    assets: {
      'main-opaque.js': { gzipBytes: criticalGzipBytes, rawBytes: 1000, sha256: 'a'.repeat(64), sourceModules: ['src/main.tsx'] },
      'main-opaque.css': { gzipBytes: 100, rawBytes: 1000, sha256: 'b'.repeat(64), sourceModules: [] },
    },
    shared: [],
    manifestErrors,
  };
}


function buildConfig({ criticalGzipBudget = 500 } = {}) {
  return {
    version: 1,
    entries: {
      main: {
        criticalGzipBudget,
        routeTotalGzipBudget: 5000,
        cssBudget: 5000,
        phase: 0,
        owner: 'frontend-platform',
      },
    },
  };
}


async function withBudgetFixture(options, callback) {
  await withGovernanceFixture(async (fixture) => {
    const health = await collectFrontendHealth({
      rootDir: fixture.rootDir,
      sourceDir: fixture.sourceDir,
      commit: FIXTURE_COMMIT,
    });
    const directory = await mkdtemp(path.join(tmpdir(), 'culina-bundle-budget-'));
    try {
      const baseline = createHealthBaseline(health, {
        bundles: {
          main: {
            gzipBytes: 1000,
            routeTotalGzipBytes: 1100,
            cssGzipBytes: 100,
          },
        },
      });
      const paths = {
        manifest: path.join(directory, 'manifest.json'),
        baseline: path.join(directory, 'baseline.json'),
        config: path.join(directory, 'budgets.json'),
        result: path.join(directory, 'result.json'),
      };
      await Promise.all([
        writeFile(paths.manifest, JSON.stringify(buildManifest(options), null, 2), 'utf8'),
        writeFile(paths.baseline, JSON.stringify(baseline, null, 2), 'utf8'),
        writeFile(paths.config, JSON.stringify(buildConfig(options), null, 2), 'utf8'),
      ]);
      await callback(paths);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });
}


function runChecker(paths, mode) {
  const result = spawnSync(process.execPath, [
    SCRIPT_PATH,
    `--mode=${mode}`,
    `--manifest=${paths.manifest}`,
    `--baseline=${paths.baseline}`,
    `--config=${paths.config}`,
    '--completed-phase=0',
    `--result=${paths.result}`,
  ], { encoding: 'utf8' });
  return {
    exitCode: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}


describe('bundle budget modes', () => {
  it('target over-budget exits 1', async () => {
    await withBudgetFixture({ criticalGzipBytes: 1000 }, async (paths) => {
      expect(runChecker(paths, 'target')).toMatchObject({ exitCode: 1 });
    });
  });

  it('ratchet allows historical gap with no delta', async () => {
    await withBudgetFixture({ criticalGzipBytes: 1000 }, async (paths) => {
      const result = runChecker(paths, 'ratchet');
      expect(result).toMatchObject({ exitCode: 0 });
      expect(result.stdout).toContain('targetGap');
    });
  });

  it('ratchet rejects 513-byte increase', async () => {
    await withBudgetFixture({ criticalGzipBytes: 1513 }, async (paths) => {
      const result = runChecker(paths, 'ratchet');
      expect(result).toMatchObject({ exitCode: 1 });
      expect(result.stderr).toContain('bundle.gzipBytes');
      expect(result.stderr).toContain('513');
    });
  });

  it('missing dynamic entry exits 1', async () => {
    await withBudgetFixture({
      manifestErrors: [{
        type: 'unregistered-dynamic-entry',
        asset: 'moved.js',
        source: 'src/components/ai/Moved.tsx',
      }],
    }, async (paths) => {
      expect(runChecker(paths, 'ratchet')).toMatchObject({ exitCode: 1 });
    });
  });

  it('report returns 0 but labels warning and error', async () => {
    await withBudgetFixture({
      criticalGzipBytes: 1000,
      manifestErrors: [{ type: 'unregistered-dynamic-entry', asset: 'moved.js' }],
    }, async (paths) => {
      const result = runChecker(paths, 'report');
      expect(result).toMatchObject({ exitCode: 0 });
      expect(result.stdout).toContain('[warning]');
      expect(result.stdout).toContain('[error]');
    });
  });

  it('uses logical entry ids instead of the first matching hashed file', async () => {
    await withBudgetFixture({ criticalGzipBytes: 1000 }, async (paths) => {
      const result = runChecker(paths, 'target');
      expect(result.stderr).toContain('main');
      expect(result.stderr).not.toContain('first matching');
    });
  });

  it('rejects an unknown mode with exit code 2', async () => {
    await withBudgetFixture({}, async (paths) => {
      expect(runChecker(paths, 'unknown')).toMatchObject({ exitCode: 2 });
    });
  });
});
