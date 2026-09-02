import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { readHealthBaseline } from './frontend-health-baseline.mjs';
import { resolveEntryMode, validateBudgetRolloutState } from './budget-rollout-state.mjs';


const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const FRONTEND_ROOT = path.resolve(SCRIPT_DIR, '..');
const DEFAULT_MANIFEST_PATH = path.join(FRONTEND_ROOT, 'dist', '.vite', 'frontend-health-manifest.json');
const DEFAULT_BASELINE_PATH = path.join(SCRIPT_DIR, 'frontend-health-baseline.json');
const DEFAULT_CONFIG_PATH = path.join(SCRIPT_DIR, 'bundle-budgets.json');
const PUBLIC_IMAGE_BUDGET = 1536 * 1024;
const BUNDLE_RATCHET_TOLERANCE_BYTES = 8 * 1024;
const PUBLIC_IMAGE_EXTENSIONS = new Set(['.avif', '.gif', '.jpg', '.jpeg', '.png', '.svg', '.webp']);
const DISALLOWED_PUBLIC_FILES = new Set(['.DS_Store']);
const MODES = new Set(['report', 'ratchet', 'target']);


function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}


function formatKiB(bytes) {
  return `${(bytes / 1024).toFixed(2)} KiB`;
}


function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}


function assertNonNegativeInteger(value, label) {
  if (!Number.isInteger(value) || value < 0) throw new Error(`${label} must be a non-negative integer`);
}


function validateBudgetConfig(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error('bundle budgets config must be an object');
  }
  if (config.version !== 1 || !config.entries || typeof config.entries !== 'object') {
    throw new Error('bundle budgets config must contain version 1 and entries');
  }
  for (const [entry, budget] of Object.entries(config.entries)) {
    if (!budget || typeof budget !== 'object') throw new Error(`bundle budget ${entry} must be an object`);
    for (const metric of ['criticalGzipBudget', 'routeTotalGzipBudget', 'cssBudget', 'phase']) {
      assertNonNegativeInteger(budget[metric], `bundle budget ${entry}.${metric}`);
    }
    if (budget.routeMetric !== undefined && budget.routeMetric !== 'routeTotalGzipBytes' && budget.routeMetric !== 'routeTransferGzipBytes') {
      throw new Error(`bundle budget ${entry}.routeMetric must be routeTotalGzipBytes or routeTransferGzipBytes`);
    }
    if (typeof budget.owner !== 'string' || !budget.owner) {
      throw new Error(`bundle budget ${entry}.owner must be a non-empty string`);
    }
  }
  return config;
}


function validateManifest(manifest) {
  if (!manifest || manifest.version !== 1 || !manifest.entries || !manifest.assets) {
    throw new Error('frontend health manifest must contain version 1, entries, and assets');
  }
  return manifest;
}


function entryMetrics(entry, manifest) {
  const cssGzipBytes = [...new Set(entry.css ?? [])].reduce((total, asset) => {
    const gzipBytes = manifest.assets[asset]?.gzipBytes;
    if (!Number.isInteger(gzipBytes)) throw new Error(`manifest CSS asset is unresolved: ${asset}`);
    return total + gzipBytes;
  }, 0);
  return {
    criticalGzipBytes: entry.entryCritical?.gzipBytes,
    routeTotalGzipBytes: entry.routeTotal?.gzipBytes,
    routeTransferGzipBytes: entry.routeTransfer?.gzipBytes ?? entry.routeTotal?.gzipBytes,
    cssGzipBytes,
  };
}


function baselineMetric(bundle, metric) {
  if (!bundle) return undefined;
  if (metric === 'criticalGzipBytes') {
    return bundle.criticalGzipBytes ?? bundle.gzipBytes;
  }
  return bundle[metric];
}


function diagnostic({ severity, entry, metric, current, allowed, delta, source, targetGap }) {
  return {
    severity,
    entry,
    metric,
    current,
    allowed,
    delta,
    source,
    ...(targetGap ? { targetGap: true } : {}),
  };
}


function compareEntry({ mode, entry, metrics, budget, baseline, completedPhase }) {
  const warnings = [];
  const violations = [];
  const metricDefinitions = [
    { key: 'criticalGzipBytes', target: budget.criticalGzipBudget, label: 'entryCritical.gzipBytes' },
    { key: budget.routeMetric ?? 'routeTotalGzipBytes', target: budget.routeTotalGzipBudget, label: budget.routeMetric === 'routeTransferGzipBytes' ? 'routeTransfer.gzipBytes' : 'routeTotal.gzipBytes' },
    { key: 'cssGzipBytes', target: budget.cssBudget, label: 'css.gzipBytes' },
  ];
  for (const definition of metricDefinitions) {
    const current = metrics[definition.key];
    assertNonNegativeInteger(current, `${entry}.${definition.key}`);
    const baselineValue = baselineMetric(baseline, definition.key);
    const hasBaseline = Number.isInteger(baselineValue);
    const delta = hasBaseline ? current - baselineValue : undefined;
    const source = definition.key === 'criticalGzipBytes' ? 'entryCritical' : definition.key;
    const targetGap = current > definition.target;

    if (mode === 'report') {
      if (targetGap) {
        warnings.push(diagnostic({
          severity: 'warning', entry, metric: definition.label, current, allowed: definition.target, delta, source, targetGap: true,
        }));
      }
      continue;
    }

    if (mode === 'ratchet' || (mode === 'target' && budget.phase > completedPhase)) {
      if (hasBaseline && delta > BUNDLE_RATCHET_TOLERANCE_BYTES) {
        violations.push(diagnostic({
          severity: 'error',
          entry,
          metric: definition.key === 'criticalGzipBytes' ? 'bundle.gzipBytes' : definition.label,
          current,
          allowed: baselineValue + BUNDLE_RATCHET_TOLERANCE_BYTES,
          delta,
          source,
        }));
      } else if (targetGap) {
        warnings.push(diagnostic({
          severity: 'warning', entry, metric: definition.label, current, allowed: definition.target, delta, source, targetGap: true,
        }));
      }
      continue;
    }

    if (targetGap) {
      violations.push(diagnostic({
        severity: 'error', entry, metric: definition.label, current, allowed: definition.target, delta, source,
      }));
    }
  }
  return { warnings, violations };
}


function publicAssetViolations(publicAssetDirs) {
  const violations = [];
  for (const directory of publicAssetDirs) {
    if (!existsSync(directory.path)) continue;
    for (const file of readdirSync(directory.path).sort(compareText)) {
      const assetPath = path.join(directory.path, file);
      if (DISALLOWED_PUBLIC_FILES.has(file)) {
        violations.push({ type: 'public-asset', entry: directory.label, metric: 'disallowed-file', source: file });
        continue;
      }
      if (!PUBLIC_IMAGE_EXTENSIONS.has(path.extname(file).toLowerCase())) continue;
      const current = statSync(assetPath).size;
      if (current > PUBLIC_IMAGE_BUDGET) {
        violations.push({
          type: 'public-asset',
          entry: directory.label,
          metric: 'image.rawBytes',
          current,
          allowed: PUBLIC_IMAGE_BUDGET,
          delta: current - PUBLIC_IMAGE_BUDGET,
          source: file,
        });
      }
    }
  }
  return violations;
}


function sortDiagnostics(items) {
  return items.sort((left, right) => (
    compareText(left.entry ?? '', right.entry ?? '')
    || compareText(left.metric ?? '', right.metric ?? '')
    || compareText(left.source ?? '', right.source ?? '')
    || compareText(left.type ?? '', right.type ?? '')
  ));
}


export function parseMode(argv) {
  const modeArgument = argv.find((argument) => argument.startsWith('--mode='));
  const mode = modeArgument?.slice('--mode='.length) ?? 'report';
  if (!MODES.has(mode)) {
    const error = new Error(`unknown mode: ${mode}`);
    error.exitCode = 2;
    throw error;
  }
  return mode;
}


export async function runBundleBudgetCheck({
  mode = 'report',
  manifestPath = DEFAULT_MANIFEST_PATH,
  baselinePath = DEFAULT_BASELINE_PATH,
  configPath = DEFAULT_CONFIG_PATH,
  completedPhase = 0,
  rolloutPath,
  publicAssetDirs = [
    { label: 'assets', path: path.join(FRONTEND_ROOT, 'dist', 'assets') },
    { label: 'images', path: path.join(FRONTEND_ROOT, 'dist', 'images') },
  ],
} = {}) {
  if (!MODES.has(mode)) throw new Error(`unknown mode: ${mode}`);
  assertNonNegativeInteger(completedPhase, 'completedPhase');
  const manifest = validateManifest(readJson(manifestPath));
  const baseline = await readHealthBaseline(baselinePath);
  const config = validateBudgetConfig(readJson(configPath));
  const rollout = rolloutPath ? validateBudgetRolloutState(readJson(rolloutPath), config) : null;
  const warnings = [];
  const violations = [];
  const manifestErrors = [...(manifest.manifestErrors ?? [])];

  for (const [entry, budget] of Object.entries(config.entries).sort(([left], [right]) => compareText(left, right))) {
    const manifestEntry = manifest.entries[entry];
    if (!manifestEntry) {
      manifestErrors.push({ type: 'missing-entry', entry });
      continue;
    }
    const compared = compareEntry({
      mode: mode === 'report' ? 'report' : (rollout ? resolveEntryMode(rollout.entries[entry]) : mode),
      entry,
      metrics: entryMetrics(manifestEntry, manifest),
      budget,
      baseline: baseline.bundles[entry],
      completedPhase,
    });
    warnings.push(...compared.warnings);
    violations.push(...compared.violations);
  }
  violations.push(...publicAssetViolations(publicAssetDirs));

  const result = {
    mode,
    warnings: sortDiagnostics(warnings),
    violations: sortDiagnostics(violations),
    manifestErrors: sortDiagnostics(manifestErrors),
  };
  result.exitCode = mode === 'report' || (result.violations.length === 0 && result.manifestErrors.length === 0) ? 0 : 1;
  return result;
}


function formatDiagnostic(item) {
  const values = [
    item.entry ? `entry=${item.entry}` : null,
    item.metric ? `metric=${item.metric}` : null,
    Number.isInteger(item.current) ? `current=${item.current}` : null,
    Number.isInteger(item.allowed) ? `allowed=${item.allowed}` : null,
    Number.isInteger(item.delta) ? `delta=${item.delta}` : null,
    item.source ? `source=${item.source}` : null,
    item.targetGap ? 'targetGap=true' : null,
    item.type ? `type=${item.type}` : null,
  ].filter(Boolean);
  return values.join(' ');
}


function parseArguments(argv) {
  const options = {};
  for (const argument of argv) {
    if (argument.startsWith('--mode=')) options.mode = argument.slice('--mode='.length);
    else if (argument.startsWith('--manifest=')) options.manifestPath = argument.slice('--manifest='.length);
    else if (argument.startsWith('--baseline=')) options.baselinePath = argument.slice('--baseline='.length);
    else if (argument.startsWith('--config=')) options.configPath = argument.slice('--config='.length);
    else if (argument.startsWith('--rollout=')) options.rolloutPath = argument.slice('--rollout='.length);
    else if (argument.startsWith('--result=')) options.resultPath = argument.slice('--result='.length);
    else if (argument.startsWith('--completed-phase=')) options.completedPhase = Number(argument.slice('--completed-phase='.length));
    else throw new Error(`unknown argument: ${argument}`);
  }
  options.mode = parseMode(argv);
  return options;
}


async function runCli() {
  const options = parseArguments(process.argv.slice(2));
  const result = await runBundleBudgetCheck(options);
  for (const warning of result.warnings) process.stdout.write(`[warning] ${formatDiagnostic(warning)}\n`);
  for (const manifestError of result.manifestErrors) {
    const output = options.mode === 'report' ? process.stdout : process.stderr;
    output.write(`[error] ${formatDiagnostic(manifestError)}\n`);
  }
  for (const violation of result.violations) {
    const output = options.mode === 'report' ? process.stdout : process.stderr;
    output.write(`[error] ${formatDiagnostic(violation)}\n`);
  }
  if (options.resultPath) {
    writeFileSync(path.resolve(process.cwd(), options.resultPath), `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  }
  process.exitCode = result.exitCode;
}


if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli().catch((error) => {
    process.stderr.write(`${error.stack ?? error.message}\n`);
    process.exitCode = error.exitCode ?? 1;
  });
}
