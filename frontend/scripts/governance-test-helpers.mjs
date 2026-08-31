import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';


export function assertCommandResult(result, expectations) {
  const output = [
    `stdout:\n${result.stdout ?? ''}`,
    `stderr:\n${result.stderr ?? ''}`,
  ].join('\n');

  if (result.exitCode !== expectations.exitCode) {
    throw new Error(
      `expected exit code ${expectations.exitCode}, received ${result.exitCode}\n${output}`,
    );
  }

  for (const [stream, expected] of [
    ['stdout', expectations.stdoutIncludes],
    ['stderr', expectations.stderrIncludes],
  ]) {
    if (!expected) continue;
    const values = Array.isArray(expected) ? expected : [expected];
    for (const value of values) {
      if (!result[stream]?.includes(value)) {
        throw new Error(`expected ${stream} to include ${JSON.stringify(value)}\n${output}`);
      }
    }
  }
}


export async function createFixtureTree(rootDir) {
  const sourceDir = path.join(rootDir, 'src');
  const distDir = path.join(rootDir, 'dist');
  const files = {
    component: path.join(sourceDir, 'FixtureComponent.tsx'),
    staticModule: path.join(sourceDir, 'fixture-value.ts'),
    dynamicModule: path.join(sourceDir, 'fixture-dynamic.ts'),
    styles: path.join(sourceDir, 'fixture.css'),
  };

  await mkdir(sourceDir, { recursive: true });
  await mkdir(distDir, { recursive: true });
  await Promise.all([
    writeFile(
      files.component,
      [
        "import { fixtureValue } from './fixture-value';",
        '',
        'export function FixtureComponent() {',
        '  return <span>{fixtureValue}</span>;',
        '}',
        '',
        'export function loadFixtureDynamic() {',
        "  return import('./fixture-dynamic');",
        '}',
        '',
      ].join('\n'),
      'utf8',
    ),
    writeFile(files.staticModule, "export const fixtureValue = 'fixture';\n", 'utf8'),
    writeFile(files.dynamicModule, "export const fixtureDynamicValue = 'dynamic';\n", 'utf8'),
    writeFile(
      files.styles,
      [
        '.fixture-card {',
        '  color: var(--fixture-safe, #123456);',
        '}',
        '',
        '.fixture-action {',
        '  color: var(--fixture-missing);',
        '  padding: 8px !important;',
        '}',
        '',
        '/* !important in a comment must not count. */',
        '@media (min-width: 768px) {}',
        '',
        '@keyframes fixture-fade {',
        '  0% { opacity: 0; }',
        '  100% { opacity: 1; }',
        '}',
        '',
      ].join('\n'),
      'utf8',
    ),
  ]);

  return {
    rootDir,
    sourceDir,
    distDir,
    files,
    expected: {
      sourceFiles: 3,
      dynamicEdges: 1,
      selectorBlocks: 2,
      important: 1,
      media: 1,
      fallbackVariables: ['--fixture-safe'],
      undefinedVariables: ['--fixture-missing'],
    },
  };
}


export async function withGovernanceFixture(callback) {
  const rootDir = await mkdtemp(path.join(tmpdir(), 'culina-governance-fixture-'));
  try {
    const fixture = await createFixtureTree(rootDir);
    return await callback(fixture);
  } finally {
    await rm(rootDir, { force: true, recursive: true });
  }
}
