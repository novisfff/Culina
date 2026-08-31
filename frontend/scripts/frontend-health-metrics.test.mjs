import { appendFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { withGovernanceFixture } from './governance-test-helpers.mjs';
import {
  collectFrontendHealth,
  formatHealthMarkdown,
  validateFrontendHealth,
} from './frontend-health-metrics.mjs';


function collectFixtureHealth(fixture, options = {}) {
  return collectFrontendHealth({
    rootDir: fixture.rootDir,
    sourceDir: fixture.sourceDir,
    commit: '0123456789abcdef0123456789abcdef01234567',
    ...options,
  });
}


describe('frontend health metrics', () => {
  it('collects TSX/CSS counts and stable hotspot order', async () => {
    await withGovernanceFixture(async (fixture) => {
      const report = await collectFixtureHealth(fixture);

      expect(report.source).toMatchObject({
        files: 3,
        lines: 11,
        byExtension: { '.ts': 2, '.tsx': 1 },
        paths: [
          'src/FixtureComponent.tsx',
          'src/fixture-dynamic.ts',
          'src/fixture-value.ts',
        ],
      });
      expect(report.css).toMatchObject({
        files: 1,
        selectorBlocks: 2,
        declarations: 3,
        important: 1,
        media: 1,
      });
      expect(report.source.hotspots.map((hotspot) => hotspot.file)).toEqual([
        'src/FixtureComponent.tsx',
        'src/fixture-dynamic.ts',
        'src/fixture-value.ts',
      ]);
      expect(validateFrontendHealth(report)).toEqual({ valid: true });
      expect(formatHealthMarkdown(report)).toContain('| Source |');
    });
  });

  it('uses AST for static and dynamic import edges', async () => {
    await withGovernanceFixture(async (fixture) => {
      const report = await collectFixtureHealth(fixture);

      expect(report.dependencies.edges).toEqual([
        {
          from: 'src/FixtureComponent.tsx',
          to: './fixture-value',
          kind: 'static',
          line: 1,
        },
        {
          from: 'src/FixtureComponent.tsx',
          to: './fixture-dynamic',
          kind: 'dynamic',
          line: 8,
        },
      ]);
    });
  });

  it('ignores comments, strings, and keyframes when counting CSS', async () => {
    await withGovernanceFixture(async (fixture) => {
      await appendFile(
        fixture.files.styles,
        '\n.fixture-label { content: "var(--fake) !important"; }\n',
        'utf8',
      );

      const report = await collectFixtureHealth(fixture);

      expect(report.css).toMatchObject({
        selectorBlocks: 3,
        declarations: 4,
        important: 1,
        media: 1,
      });
      expect(report.css.variables.map(({ name, classification }) => ({ name, classification }))).toEqual([
        { name: '--fixture-safe', classification: 'fallback-safe' },
        { name: '--fixture-missing', classification: 'undefined' },
      ]);
    });
  });

  it('classifies fallback and runtime variables', async () => {
    await withGovernanceFixture(async (fixture) => {
      await appendFile(
        fixture.files.styles,
        '\n.fixture-runtime { inset: var(--fixture-runtime); }\n',
        'utf8',
      );

      const report = await collectFixtureHealth(fixture, {
        exceptions: {
          version: 1,
          exceptions: [{
            metric: 'runtime-variable',
            variable: '--fixture-runtime',
            file: 'src/fixture.css',
            owner: 'frontend-platform',
            source: 'visual viewport',
            fallback: '0px',
            consumers: ['fixture runtime test'],
            reason: 'browser-provided inset',
            introducedAt: '2026-08-27',
            expiresAt: '2026-12-31',
            replacement: 'canonical inset token',
            test: 'scripts/frontend-health-metrics.test.mjs',
          }],
        },
      });

      expect(report.css.variables.map(({ name, classification }) => ({ name, classification }))).toEqual([
        { name: '--fixture-safe', classification: 'fallback-safe' },
        { name: '--fixture-missing', classification: 'undefined' },
        { name: '--fixture-runtime', classification: 'runtime-allowed' },
      ]);
    });
  });

  it('sorts paths, metrics, and selectors deterministically', async () => {
    await withGovernanceFixture(async (fixture) => {
      await writeFile(
        path.join(fixture.sourceDir, 'a.css'),
        '.alpha { color: var(--alpha, #fff); }\n',
        'utf8',
      );

      const first = await collectFixtureHealth(fixture);
      const second = await collectFixtureHealth(fixture);

      expect(first.css.paths).toEqual(['src/a.css', 'src/fixture.css']);
      expect(first.css.hits.map((hit) => `${hit.file}:${hit.metric}:${hit.value}`)).toEqual([
        'src/a.css:selector:.alpha',
        'src/a.css:declaration:color',
        'src/a.css:variable:--alpha',
        'src/fixture.css:selector:.fixture-card',
        'src/fixture.css:declaration:color',
        'src/fixture.css:variable:--fixture-safe',
        'src/fixture.css:selector:.fixture-action',
        'src/fixture.css:declaration:color',
        'src/fixture.css:variable:--fixture-missing',
        'src/fixture.css:declaration:padding',
        'src/fixture.css:important:!important',
        'src/fixture.css:media:@media (min-width: 768px)',
      ]);
      expect(second).toEqual(first);
    });
  });

  it('rejects expired or incomplete exceptions', async () => {
    await withGovernanceFixture(async (fixture) => {
      await expect(collectFixtureHealth(fixture, {
        exceptions: {
          version: 1,
          exceptions: [{
            metric: 'runtime-variable',
            variable: '--fixture-runtime',
            file: 'src/fixture.css',
            owner: 'frontend-platform',
            source: 'visual viewport',
            fallback: '0px',
            consumers: ['fixture runtime test'],
            reason: 'expired fixture',
            introducedAt: '2026-08-27',
            expiresAt: '2026-08-01',
            replacement: 'canonical inset token',
            test: 'scripts/frontend-health-metrics.test.mjs',
          }],
        },
      })).rejects.toThrow(/expired exception/);

      await expect(collectFixtureHealth(fixture, {
        exceptions: {
          version: 1,
          exceptions: [{
            metric: 'runtime-variable',
            variable: '--fixture-runtime',
            file: 'src/fixture.css',
            owner: 'frontend-platform',
            source: 'visual viewport',
            fallback: '0px',
            consumers: [],
            reason: 'incomplete fixture',
            introducedAt: '2026-08-27',
            expiresAt: '2026-12-31',
            replacement: 'canonical inset token',
            test: 'scripts/frontend-health-metrics.test.mjs',
          }],
        },
      })).rejects.toThrow(/consumers/);
    });
  });
});
