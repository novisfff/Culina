import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { runBundleBudgetCheck } from './check-bundle-budgets.mjs';
import { validateFrontendHealth } from './frontend-health-metrics.mjs';


const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const FRONTEND_ROOT = path.resolve(SCRIPT_DIR, '..');
const ARTIFACT_ROOT = path.resolve(FRONTEND_ROOT, '..', '.artifacts');


function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}


async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, 'utf8'));
}


function sortRecords(records) {
  return records.sort((left, right) => (
    compareText(left.check ?? '', right.check ?? '')
    || compareText(left.reason ?? '', right.reason ?? '')
  ));
}


function validateManifest(manifest) {
  if (!manifest || manifest.version !== 1 || !manifest.entries || !manifest.assets) {
    throw new Error('manifest is missing version 1, entries, or assets');
  }
  if (!Array.isArray(manifest.manifestErrors)) {
    throw new Error('manifest is missing manifestErrors');
  }
  if (manifest.manifestErrors.length > 0) {
    throw new Error(`manifest contains ${manifest.manifestErrors.length} errors`);
  }
}


async function readResult(result) {
  return typeof result === 'string' ? readJson(result) : result;
}


export async function runFrontendGovernance({
  healthPath,
  manifestPath,
  resultPaths = {},
  mode = 'ratchet',
} = {}) {
  const checks = [];
  const violations = [];
  const verify = async (name, operation) => {
    try {
      await operation();
      checks.push({ name, status: 'success' });
    } catch (error) {
      checks.push({ name, status: 'failure' });
      violations.push({ check: name, reason: error instanceof Error ? error.message : String(error) });
    }
  };

  await verify('health', async () => {
    const health = await readJson(healthPath);
    const validation = validateFrontendHealth(health);
    if (!validation.valid) throw new Error(validation.errors.join(', '));
  });
  await verify('manifest', async () => validateManifest(await readJson(manifestPath)));
  for (const [name, resultPath] of Object.entries(resultPaths).sort(([left], [right]) => compareText(left, right))) {
    await verify(name, async () => {
      const result = await readResult(resultPath);
      if (!result || result.exitCode !== 0) {
        throw new Error(`child result exited ${result?.exitCode ?? 'without a result'}`);
      }
      if (result.status !== undefined && result.status !== 'success') {
        throw new Error(`child result status is ${result.status}`);
      }
      if ((result.violations?.length ?? 0) > 0 || (result.manifestErrors?.length ?? 0) > 0) {
        throw new Error('child result contains violations or manifest errors');
      }
    });
  }

  return {
    mode,
    checks: checks.sort((left, right) => compareText(left.name, right.name)),
    violations: sortRecords(violations),
    exitCode: violations.length === 0 ? 0 : 1,
  };
}


function parseArguments(argv) {
  const options = {
    mode: 'report',
    healthPath: path.join(ARTIFACT_ROOT, 'frontend-health.json'),
    manifestPath: path.join(ARTIFACT_ROOT, 'frontend-health-manifest.json'),
    baselinePath: path.join(SCRIPT_DIR, 'frontend-health-baseline.json'),
    configPath: path.join(SCRIPT_DIR, 'bundle-budgets.json'),
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument.startsWith('--mode=')) options.mode = argument.slice('--mode='.length);
    else if (argument.startsWith('--health=')) options.healthPath = argument.slice('--health='.length);
    else if (argument.startsWith('--manifest=')) options.manifestPath = argument.slice('--manifest='.length);
    else if (argument.startsWith('--baseline=')) options.baselinePath = argument.slice('--baseline='.length);
    else if (argument.startsWith('--config=')) options.configPath = argument.slice('--config='.length);
    else if (argument.startsWith('--result=')) options.resultPath = argument.slice('--result='.length);
    else if (argument.startsWith('--completed-phase=')) options.completedPhase = Number(argument.slice('--completed-phase='.length));
    else if (argument === '--fixtures') options.fixturesPath = argv[++index];
    else if (argument.startsWith('--fixtures=')) options.fixturesPath = argument.slice('--fixtures='.length);
    else throw new Error(`unknown argument: ${argument}`);
  }
  return options;
}


async function runFixtureSuite(fixturesPath) {
  const root = path.resolve(process.cwd(), fixturesPath);
  const entries = await readdir(root, { withFileTypes: true });
  const scenarios = entries.filter((entry) => entry.isDirectory()).sort((left, right) => compareText(left.name, right.name));
  let mismatches = 0;
  for (const scenario of scenarios) {
    const directory = path.join(root, scenario.name);
    const expected = await readJson(path.join(directory, 'expected.json'));
    const result = await runFrontendGovernance({
      healthPath: path.join(directory, 'frontend-health.json'),
      manifestPath: path.join(directory, 'frontend-health-manifest.json'),
      resultPaths: { bundle: path.join(directory, 'bundle-result.json') },
      mode: 'ratchet',
    });
    process.stdout.write(`${scenario.name}: expected=${expected.exitCode} actual=${result.exitCode}\n`);
    if (result.exitCode !== expected.exitCode) mismatches += 1;
  }
  return mismatches === 0 ? 0 : 1;
}


async function runCli() {
  const options = parseArguments(process.argv.slice(2));
  if (options.fixturesPath) {
    process.exitCode = await runFixtureSuite(options.fixturesPath);
    return;
  }
  let bundle;
  try {
    bundle = await runBundleBudgetCheck({
      mode: options.mode,
      manifestPath: options.manifestPath,
      baselinePath: options.baselinePath,
      configPath: options.configPath,
      completedPhase: options.completedPhase ?? 0,
    });
  } catch (error) {
    bundle = {
      exitCode: 1,
      violations: [{ reason: error instanceof Error ? error.message : String(error) }],
      manifestErrors: [],
    };
  }
  const result = await runFrontendGovernance({
    healthPath: options.healthPath,
    manifestPath: options.manifestPath,
    resultPaths: { bundle },
    mode: options.mode,
  });
  if (options.resultPath) {
    await writeFile(path.resolve(process.cwd(), options.resultPath), `${JSON.stringify({ ...result, bundle }, null, 2)}\n`, 'utf8');
  }
  for (const violation of result.violations) {
    process.stderr.write(`[error] ${violation.check}: ${violation.reason}\n`);
  }
  process.exitCode = result.exitCode;
}


if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli().catch((error) => {
    process.stderr.write(`${error.stack ?? error.message}\n`);
    process.exitCode = 1;
  });
}
