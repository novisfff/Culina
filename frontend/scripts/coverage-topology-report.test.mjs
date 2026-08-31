import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { collectCoverageTopology, formatCoverageSummary } from './coverage-topology-report.mjs';


const temporaryDirectories = [];


async function createFixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'culina-coverage-topology-'));
  temporaryDirectories.push(root);
  const sourceDir = path.join(root, 'src');
  const coverageDir = path.join(root, 'coverage');
  await mkdir(path.join(sourceDir, 'components', 'ingredients'), { recursive: true });
  await mkdir(path.join(sourceDir, 'lib'), { recursive: true });
  await mkdir(coverageDir, { recursive: true });
  await Promise.all([
    writeFile(path.join(sourceDir, 'App.tsx'), 'export const App = () => null;\n', 'utf8'),
    writeFile(
      path.join(sourceDir, 'components', 'ingredients', 'IngredientWorkspace.tsx'),
      'export const IngredientWorkspace = () => null;\n',
      'utf8',
    ),
    writeFile(path.join(sourceDir, 'lib', 'covered.ts'), 'export const covered = true;\n', 'utf8'),
    writeFile(path.join(coverageDir, 'vitest-results.json'), JSON.stringify({
      numTotalTestSuites: 4,
      numTotalTests: 3,
      testResults: [
        { name: 'src/App.test.tsx', status: 'passed', assertionResults: [] },
        { name: 'src/lib/covered.test.ts', status: 'passed', assertionResults: [] },
      ],
    }), 'utf8'),
  ]);
  return { root, sourceDir, coverageDir };
}


function metric(total, covered) {
  return { total, covered, skipped: 0, pct: total === 0 ? 100 : (covered / total) * 100 };
}


function fileCoverage(linesTotal, linesCovered) {
  return {
    lines: metric(linesTotal, linesCovered),
    statements: metric(linesTotal, linesCovered),
    functions: metric(1, linesCovered > 0 ? 1 : 0),
    branches: metric(0, 0),
  };
}


afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })));
});


describe('coverage topology report', () => {
  it('keeps the coverage command, aggregator input, and uploaded artifacts under contract', async () => {
    const frontendPackage = JSON.parse(await readFile(path.resolve(process.cwd(), 'package.json'), 'utf8'));
    const workflow = await readFile(
      path.resolve(process.cwd(), '..', '.github', 'workflows', 'quality-gates.yml'),
      'utf8',
    );

    const coverageCommand = frontendPackage.scripts['coverage:report'];
    expect(coverageCommand).toBeTypeOf('string');
    expect(coverageCommand).toContain('--reporter=json');
    expect(coverageCommand).toContain('coverage-topology-report.mjs');
    for (const required of [
      'npm --prefix frontend run coverage:report',
      '--coverage="$GITHUB_WORKSPACE/.artifacts/frontend-coverage-topology.json"',
      '.artifacts/frontend-coverage-topology.json',
      'frontend/coverage/coverage-summary.json',
      'frontend/coverage/vitest-results.json',
      'if: always()',
    ]) {
      expect(workflow).toContain(required);
    }
  });

  it('reports uncovered composition files even when global coverage is high', async () => {
    const fixture = await createFixture();
    await writeFile(path.join(fixture.coverageDir, 'coverage-summary.json'), JSON.stringify({
      total: {
        lines: metric(100, 95),
        statements: metric(100, 95),
        functions: metric(20, 19),
        branches: metric(20, 19),
      },
      [path.join(fixture.sourceDir, 'App.tsx')]: fileCoverage(5, 0),
      [path.join(fixture.sourceDir, 'components', 'ingredients', 'IngredientWorkspace.tsx')]: fileCoverage(10, 5),
      [path.join(fixture.sourceDir, 'lib', 'covered.ts')]: fileCoverage(85, 85),
    }), 'utf8');

    const result = await collectCoverageTopology(fixture);

    expect(result).toMatchObject({ status: 'success', exitCode: 0, files: 2, tests: 3 });
    expect(result.total.lines.pct).toBe(95);
    expect(result.byDomain.app.lines).toMatchObject({ total: 5, covered: 0, pct: 0 });
    expect(result.byDomain.ingredients.lines).toMatchObject({ total: 10, covered: 5, pct: 50 });
    expect(result.uncoveredCompositionFiles).toEqual([
      { file: 'App.tsx', lines: { total: 5, covered: 0, pct: 0 } },
      {
        file: 'components/ingredients/IngredientWorkspace.tsx',
        lines: { total: 10, covered: 5, pct: 50 },
      },
    ]);
    expect(formatCoverageSummary(result)).toContain('App.tsx');
  });

  it('reports a missing coverage summary as an artifact error instead of zero coverage', async () => {
    const fixture = await createFixture();

    const result = await collectCoverageTopology(fixture);

    expect(result).toMatchObject({
      status: 'failure',
      exitCode: 1,
      total: null,
      artifactErrors: [{ artifact: 'coverage-summary.json', reason: 'missing' }],
    });
    expect(result.total).not.toEqual(expect.objectContaining({ lines: expect.objectContaining({ pct: 0 }) }));
  });
});
