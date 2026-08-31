import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';


const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const FRONTEND_ROOT = path.resolve(SCRIPT_DIR, '..');
const DOMAIN_NAMES = ['app', 'ingredients', 'foods', 'eat', 'ai', 'family', 'inventory', 'other'];
const METRIC_NAMES = ['lines', 'statements', 'functions', 'branches'];


function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}


function toPosixPath(value) {
  return value.split(path.sep).join('/');
}


async function readJsonArtifact(filePath, artifactErrors, artifact) {
  try {
    return JSON.parse(await readFile(filePath, 'utf8'));
  } catch (error) {
    artifactErrors.push({
      artifact,
      reason: error?.code === 'ENOENT' ? 'missing' : 'invalid-json',
    });
    return null;
  }
}


async function listSourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(entries
    .filter((entry) => !entry.name.startsWith('.'))
    .map(async (entry) => {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) return listSourceFiles(fullPath);
      return entry.isFile() && /\.(?:ts|tsx)$/.test(entry.name) ? [fullPath] : [];
    }));
  return files.flat().sort(compareText);
}


function normalizeMetric(metric) {
  return {
    total: Number(metric?.total ?? 0),
    covered: Number(metric?.covered ?? 0),
    pct: Number(metric?.pct ?? 0),
  };
}


function emptyMetrics() {
  return Object.fromEntries(METRIC_NAMES.map((name) => [name, { total: 0, covered: 0, pct: 100 }]));
}


function addMetrics(target, coverage) {
  for (const name of METRIC_NAMES) {
    target[name].total += Number(coverage?.[name]?.total ?? 0);
    target[name].covered += Number(coverage?.[name]?.covered ?? 0);
  }
}


function finalizeMetrics(metrics) {
  for (const name of METRIC_NAMES) {
    const metric = metrics[name];
    metric.pct = metric.total === 0 ? 100 : Number(((metric.covered / metric.total) * 100).toFixed(2));
  }
  return metrics;
}


function coverageDomain(file) {
  if (file === 'App.tsx' || file.startsWith('app/')) return 'app';
  if (file.startsWith('components/ingredients/')) return 'ingredients';
  if (file.startsWith('components/foods/')) return 'foods';
  if (file.startsWith('features/eat/')) return 'eat';
  if (file.startsWith('components/ai/')) return 'ai';
  if (file.startsWith('features/family/') || file.startsWith('features/family-model-settings/')) return 'family';
  if (file.startsWith('features/inventory/')) return 'inventory';
  return 'other';
}


function relativeCoveragePath(file, sourceDir) {
  const absolute = path.isAbsolute(file) ? file : path.resolve(path.dirname(sourceDir), file);
  const relative = path.relative(sourceDir, absolute);
  return toPosixPath(relative);
}


function isCompositionFile(file) {
  return file === 'App.tsx' || /(?:^|\/)\w+Workspace\.tsx$/.test(file);
}


export async function collectCoverageTopology({
  coverageDir,
  sourceDir,
  testResultsPath = path.join(coverageDir, 'vitest-results.json'),
}) {
  const artifactErrors = [];
  const summary = await readJsonArtifact(
    path.join(coverageDir, 'coverage-summary.json'),
    artifactErrors,
    'coverage-summary.json',
  );
  const testResults = await readJsonArtifact(testResultsPath, artifactErrors, path.basename(testResultsPath));
  if (testResults && !Array.isArray(testResults.testResults)) {
    artifactErrors.push({ artifact: path.basename(testResultsPath), reason: 'invalid-shape' });
  }
  const coverageByFile = new Map();
  const byDomain = Object.fromEntries(DOMAIN_NAMES.map((name) => [name, emptyMetrics()]));

  if (summary) {
    for (const [file, coverage] of Object.entries(summary)
      .filter(([file]) => file !== 'total')
      .sort(([left], [right]) => compareText(left, right))) {
      const relative = relativeCoveragePath(file, sourceDir);
      if (relative.startsWith('../')) continue;
      coverageByFile.set(relative, coverage);
      addMetrics(byDomain[coverageDomain(relative)], coverage);
    }
    for (const domain of DOMAIN_NAMES) finalizeMetrics(byDomain[domain]);
  }

  let sourceFiles = [];
  try {
    sourceFiles = await listSourceFiles(sourceDir);
  } catch (error) {
    artifactErrors.push({
      artifact: 'source-directory',
      reason: error?.code === 'ENOENT' ? 'missing' : 'unreadable',
    });
  }
  const uncoveredCompositionFiles = sourceFiles
    .map((file) => toPosixPath(path.relative(sourceDir, file)))
    .filter(isCompositionFile)
    .map((file) => ({ file, coverage: coverageByFile.get(file) }))
    .filter(({ coverage }) => !coverage || Number(coverage.lines?.pct ?? 0) < 100)
    .map(({ file, coverage }) => ({
      file,
      lines: coverage ? normalizeMetric(coverage.lines) : { total: null, covered: null, pct: null },
    }))
    .sort((left, right) => compareText(left.file, right.file));

  const failed = artifactErrors.length > 0;
  return {
    status: failed ? 'failure' : 'success',
    exitCode: failed ? 1 : 0,
    files: Array.isArray(testResults?.testResults) ? testResults.testResults.length : 0,
    tests: Number(testResults?.numTotalTests ?? 0),
    total: summary?.total
      ? Object.fromEntries(METRIC_NAMES.map((name) => [name, normalizeMetric(summary.total[name])]))
      : null,
    byDomain: summary ? byDomain : {},
    uncoveredCompositionFiles,
    artifactErrors: artifactErrors.sort((left, right) => compareText(left.artifact, right.artifact)),
  };
}


export function formatCoverageSummary(result) {
  const lines = [
    '# Frontend coverage topology',
    '',
    `Status: ${result.status}`,
    `Test files: ${result.files}`,
    `Tests: ${result.tests}`,
  ];
  if (result.total) {
    lines.push('', '| Domain | Lines | Branches | Functions |', '| --- | ---: | ---: | ---: |');
    for (const domain of DOMAIN_NAMES) {
      const metrics = result.byDomain[domain];
      lines.push(`| ${domain} | ${metrics.lines.pct}% | ${metrics.branches.pct}% | ${metrics.functions.pct}% |`);
    }
  }
  if (result.artifactErrors.length > 0) {
    lines.push('', 'Artifact errors:');
    for (const error of result.artifactErrors) lines.push(`- ${error.artifact}: ${error.reason}`);
  }
  if (result.uncoveredCompositionFiles.length > 0) {
    lines.push('', 'Uncovered composition files:');
    for (const item of result.uncoveredCompositionFiles) {
      lines.push(`- ${item.file}: ${item.lines.pct ?? 'missing'}% lines`);
    }
  }
  return `${lines.join('\n')}\n`;
}


function parseArguments(argv) {
  const options = {
    coverageDir: path.join(FRONTEND_ROOT, 'coverage'),
    sourceDir: path.join(FRONTEND_ROOT, 'src'),
    outputPath: path.resolve(FRONTEND_ROOT, '..', '.artifacts', 'frontend-coverage-topology.json'),
  };
  for (const argument of argv) {
    if (argument.startsWith('--coverage=')) options.coverageDir = path.resolve(process.cwd(), argument.slice('--coverage='.length));
    else if (argument.startsWith('--source=')) options.sourceDir = path.resolve(process.cwd(), argument.slice('--source='.length));
    else if (argument.startsWith('--tests=')) options.testResultsPath = path.resolve(process.cwd(), argument.slice('--tests='.length));
    else if (argument.startsWith('--output=')) options.outputPath = path.resolve(process.cwd(), argument.slice('--output='.length));
    else throw new Error(`unknown argument: ${argument}`);
  }
  return options;
}


async function runCli() {
  const options = parseArguments(process.argv.slice(2));
  const result = await collectCoverageTopology(options);
  await mkdir(path.dirname(options.outputPath), { recursive: true });
  await writeFile(options.outputPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  process.stdout.write(formatCoverageSummary(result));
  process.exitCode = result.exitCode;
}


if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli().catch((error) => {
    process.stderr.write(`${error.stack ?? error.message}\n`);
    process.exitCode = 1;
  });
}
