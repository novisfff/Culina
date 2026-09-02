import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { withGovernanceFixture } from './governance-test-helpers.mjs';
import { collectFrontendHealth } from './frontend-health-metrics.mjs';
import {
  assertBaselineMatchesSourceCheckout,
  compareHealthToBaseline,
  createHealthBaseline,
  readHealthBaseline,
} from './frontend-health-baseline.mjs';


const FIXTURE_COMMIT = '0123456789abcdef0123456789abcdef01234567';


async function createHealthFixture() {
  let report;
  await withGovernanceFixture(async (fixture) => {
    report = await collectFrontendHealth({
      rootDir: fixture.rootDir,
      sourceDir: fixture.sourceDir,
      commit: FIXTURE_COMMIT,
    });
  });
  return report;
}


function baselineFor(health, bundles = {}) {
  return createHealthBaseline(health, { bundles });
}


describe('frontend health baseline', () => {
  it('accepts an exact B0 report', async () => {
    const health = await createHealthFixture();
    const baseline = baselineFor(health);
    const comparison = compareHealthToBaseline(health, baseline);

    expect(baseline.health.css).toMatchObject({
      important: 1,
      importantByFile: { 'src/fixture.css': 1 },
      undefinedVariablesByFile: { 'src/fixture.css': 1 },
    });
    expect(baseline.health.css).not.toHaveProperty('hits');
    expect(comparison).toMatchObject({
      reductions: [],
      unchanged: expect.arrayContaining([
        expect.objectContaining({ metric: 'css.important' }),
        expect.objectContaining({ metric: 'css.undefinedVariables' }),
      ]),
      violations: [],
    });
  });

  it('allows a reduction', async () => {
    const health = await createHealthFixture();
    const reduced = structuredClone(health);
    reduced.css.important = 0;
    reduced.css.hits = reduced.css.hits.filter((hit) => hit.metric !== 'important');

    const comparison = compareHealthToBaseline(reduced, baselineFor(health));

    expect(comparison.reductions).toContainEqual({
      file: 'src/fixture.css',
      metric: 'css.important',
      baseline: 1,
      current: 0,
      delta: -1,
    });
    expect(comparison.violations).toEqual([]);
  });

  it('rejects a new important or undefined variable', async () => {
    const health = await createHealthFixture();
    const increased = structuredClone(health);
    increased.css.important = 2;
    increased.css.hits.push({
      file: 'src/new.css',
      line: 1,
      column: 20,
      metric: 'important',
      value: '!important',
    });
    increased.css.variables.push({
      file: 'src/new.css',
      line: 1,
      column: 1,
      name: '--new-undefined',
      classification: 'undefined',
    });
    increased.css.undefinedVariables.push('--new-undefined');

    const comparison = compareHealthToBaseline(increased, baselineFor(health));

    expect(comparison.violations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        file: 'src/new.css',
        metric: 'css.important',
        current: 1,
        allowed: 0,
        delta: 1,
      }),
      expect.objectContaining({
        file: 'src/new.css',
        metric: 'css.undefinedVariables',
        current: 1,
        allowed: 0,
        delta: 1,
      }),
    ]));
  });

  it('allows bundle delta up to 8 KiB and rejects the next byte', async () => {
    const health = await createHealthFixture();
    const baseline = baselineFor(health, { main: { gzipBytes: 1000 } });

    expect(compareHealthToBaseline(
      { ...health, bundles: { main: { gzipBytes: 9192 } } },
      baseline,
    ).violations).toEqual([]);

    expect(compareHealthToBaseline(
      { ...health, bundles: { main: { gzipBytes: 9193 } } },
      baseline,
    ).violations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        file: 'main',
        metric: 'bundle.gzipBytes',
        current: 9193,
        allowed: 9192,
        delta: 8193,
      }),
    ]));
  });

  it('rejects baseline commit that is not HEAD of source checkout', async () => {
    const health = await createHealthFixture();
    const baseline = baselineFor(health);
    const tempDir = await mkdtemp(path.join(tmpdir(), 'culina-baseline-'));
    const baselinePath = path.join(tempDir, 'baseline.json');
    await writeFile(baselinePath, JSON.stringify(baseline), 'utf8');

    await expect(readHealthBaseline(baselinePath)).resolves.toEqual(baseline);
    expect(() => assertBaselineMatchesSourceCheckout(
      baseline,
      'fedcba9876543210fedcba9876543210fedcba98',
    )).toThrow(/does not match source checkout HEAD/);
  });
});
