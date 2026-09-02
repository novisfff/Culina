import { readFile } from 'node:fs/promises';

import { validateFrontendHealth } from './frontend-health-metrics.mjs';


const SHA_PATTERN = /^[a-f0-9]{40}$/i;


function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}


function countsObject(counts) {
  return Object.fromEntries([...counts.entries()].sort(([left], [right]) => compareText(left, right)));
}


function countItemsByFile(items) {
  const counts = new Map();
  for (const item of items) {
    counts.set(item.file, (counts.get(item.file) ?? 0) + 1);
  }
  return counts;
}


function assertNonNegativeCountMap(value, pathName) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${pathName} must be an object`);
  }
  for (const [file, count] of Object.entries(value)) {
    if (!file || !Number.isInteger(count) || count < 0) {
      throw new Error(`${pathName}.${file} must be a non-negative integer`);
    }
  }
}


function assertCompactHealth(health) {
  if (!health || typeof health !== 'object' || Array.isArray(health)) {
    throw new Error('frontend health baseline health must be an object');
  }
  if (health.version !== 1) throw new Error('frontend health baseline health version must be 1');
  if (!SHA_PATTERN.test(health.source?.ref?.commit ?? '')) {
    throw new Error('frontend health baseline health.source.ref.commit must be a 40-character SHA');
  }
  for (const metric of ['important', 'media', 'selectorBlocks', 'declarations']) {
    if (!Number.isInteger(health.css?.[metric]) || health.css[metric] < 0) {
      throw new Error(`frontend health baseline health.css.${metric} must be a non-negative integer`);
    }
  }
  if (!Array.isArray(health.css?.undefinedVariables)) {
    throw new Error('frontend health baseline health.css.undefinedVariables must be an array');
  }
  assertNonNegativeCountMap(health.css.importantByFile, 'frontend health baseline health.css.importantByFile');
  assertNonNegativeCountMap(health.css.undefinedVariablesByFile, 'frontend health baseline health.css.undefinedVariablesByFile');
  assertNonNegativeCountMap(health.source.parseErrorsByFile, 'frontend health baseline health.source.parseErrorsByFile');
}


function assertBaselineShape(baseline) {
  if (!baseline || typeof baseline !== 'object' || Array.isArray(baseline)) {
    throw new Error('frontend health baseline must be an object');
  }
  if (baseline.version !== 1) throw new Error('frontend health baseline version must be 1');
  if (!SHA_PATTERN.test(baseline.sourceCommit ?? '')) {
    throw new Error('frontend health baseline sourceCommit must be a 40-character SHA');
  }
  if (baseline.generatedAtPolicy !== 'source-commit-only') {
    throw new Error('frontend health baseline generatedAtPolicy must be source-commit-only');
  }
  if (!baseline.toolchain || typeof baseline.toolchain !== 'object' || Array.isArray(baseline.toolchain)) {
    throw new Error('frontend health baseline toolchain must be an object');
  }
  assertCompactHealth(baseline.health);
  if (baseline.health.source.ref?.commit !== baseline.sourceCommit) {
    throw new Error('frontend health baseline sourceCommit must match health.source.ref.commit');
  }
  if (!baseline.bundles || typeof baseline.bundles !== 'object' || Array.isArray(baseline.bundles)) {
    throw new Error('frontend health baseline bundles must be an object');
  }
  for (const [entry, bundle] of Object.entries(baseline.bundles)) {
    if (!bundle || !Number.isInteger(bundle.gzipBytes) || bundle.gzipBytes < 0) {
      throw new Error(`frontend health baseline bundle ${entry} must have a non-negative gzipBytes integer`);
    }
    for (const metric of ['routeTotalGzipBytes', 'cssGzipBytes']) {
      if (bundle[metric] !== undefined && (!Number.isInteger(bundle[metric]) || bundle[metric] < 0)) {
        throw new Error(`frontend health baseline bundle ${entry}.${metric} must be a non-negative integer`);
      }
    }
  }
  return baseline;
}


export function createHealthBaseline(report, { bundles = {} } = {}) {
  const validation = validateFrontendHealth(report);
  if (!validation.valid) {
    throw new Error(`cannot create frontend health baseline from invalid report: ${validation.errors.join(', ')}`);
  }
  const sourceCommit = report.source.ref.commit;
  const baseline = {
    version: 1,
    sourceCommit,
    generatedAtPolicy: 'source-commit-only',
    toolchain: { ...report.toolchain },
    health: {
      version: report.version,
      source: {
        ref: { ...report.source.ref },
        parseErrorsByFile: countsObject(countItemsByFile(report.source.parseErrors ?? [])),
      },
      css: {
        important: report.css.important,
        media: report.css.media,
        selectorBlocks: report.css.selectorBlocks,
        declarations: report.css.declarations,
        undefinedVariables: [...report.css.undefinedVariables].sort(compareText),
        importantByFile: countsObject(countHitsByFile(report, 'important')),
        undefinedVariablesByFile: countsObject(countUndefinedVariablesByFile(report)),
      },
    },
    bundles: Object.fromEntries(Object.entries(bundles)
      .sort(([left], [right]) => compareText(left, right))
      .map(([entry, bundle]) => [entry, {
        gzipBytes: bundle.gzipBytes,
        ...(bundle.routeTotalGzipBytes === undefined ? {} : { routeTotalGzipBytes: bundle.routeTotalGzipBytes }),
        ...(bundle.cssGzipBytes === undefined ? {} : { cssGzipBytes: bundle.cssGzipBytes }),
      }])),
  };
  return assertBaselineShape(baseline);
}


export async function readHealthBaseline(baselinePath) {
  const baseline = JSON.parse(await readFile(baselinePath, 'utf8'));
  return assertBaselineShape(baseline);
}


export function assertBaselineMatchesSourceCheckout(baseline, sourceCheckoutHead) {
  assertBaselineShape(baseline);
  if (baseline.sourceCommit !== sourceCheckoutHead) {
    throw new Error(
      `frontend health baseline sourceCommit ${baseline.sourceCommit} does not match source checkout HEAD ${sourceCheckoutHead}`,
    );
  }
  return baseline;
}


function countHitsByFile(report, metric) {
  const counts = new Map();
  for (const hit of report.css.hits ?? []) {
    if (hit.metric !== metric) continue;
    counts.set(hit.file, (counts.get(hit.file) ?? 0) + 1);
  }
  return counts;
}


function countUndefinedVariablesByFile(report) {
  const counts = new Map();
  for (const variable of report.css.variables ?? []) {
    if (variable.classification !== 'undefined') continue;
    counts.set(variable.file, (counts.get(variable.file) ?? 0) + 1);
  }
  return counts;
}


function compareCounts(metric, currentCounts, baselineCounts) {
  const files = new Set([...currentCounts.keys(), ...baselineCounts.keys()]);
  const comparison = { reductions: [], unchanged: [], violations: [] };
  for (const file of [...files].sort(compareText)) {
    const current = currentCounts.get(file) ?? 0;
    const baseline = baselineCounts.get(file) ?? 0;
    const delta = current - baseline;
    const record = { file, metric, baseline, current, delta };
    if (delta > 0) comparison.violations.push({ ...record, allowed: baseline });
    else if (delta < 0) comparison.reductions.push(record);
    else comparison.unchanged.push(record);
  }
  return comparison;
}


function mergeComparison(target, source) {
  target.reductions.push(...source.reductions);
  target.unchanged.push(...source.unchanged);
  target.violations.push(...source.violations);
}


function bundleBytes(report) {
  const entries = report.bundles ?? {};
  const result = new Map();
  for (const [entry, bundle] of Object.entries(entries)) {
    if (!Number.isInteger(bundle?.gzipBytes) || bundle.gzipBytes < 0) {
      throw new Error(`bundle ${entry} must have a non-negative gzipBytes integer`);
    }
    result.set(entry, bundle.gzipBytes);
  }
  return result;
}


export function compareHealthToBaseline(current, baseline, { toleranceBytes = 8 * 1024 } = {}) {
  assertBaselineShape(baseline);
  if (!Number.isInteger(toleranceBytes) || toleranceBytes < 0) {
    throw new Error('toleranceBytes must be a non-negative integer');
  }
  const currentValidation = validateFrontendHealth(current);
  if (!currentValidation.valid) {
    throw new Error(`current frontend health report is invalid: ${currentValidation.errors.join(', ')}`);
  }

  const comparison = { reductions: [], unchanged: [], violations: [] };
  mergeComparison(comparison, compareCounts(
    'css.important',
    countHitsByFile(current, 'important'),
    new Map(Object.entries(baseline.health.css.importantByFile)),
  ));
  mergeComparison(comparison, compareCounts(
    'css.undefinedVariables',
    countUndefinedVariablesByFile(current),
    new Map(Object.entries(baseline.health.css.undefinedVariablesByFile)),
  ));
  mergeComparison(comparison, compareCounts(
    'source.parseErrors',
    countItemsByFile(current.source.parseErrors ?? []),
    new Map(Object.entries(baseline.health.source.parseErrorsByFile)),
  ));

  const currentBundles = bundleBytes(current);
  const baselineBundles = new Map(Object.entries(baseline.bundles)
    .map(([entry, bundle]) => [entry, bundle.gzipBytes]));
  for (const entry of [...new Set([...currentBundles.keys(), ...baselineBundles.keys()])].sort(compareText)) {
    const currentBytes = currentBundles.get(entry) ?? 0;
    const baselineBytes = baselineBundles.get(entry) ?? 0;
    const delta = currentBytes - baselineBytes;
    const record = {
      file: entry,
      metric: 'bundle.gzipBytes',
      baseline: baselineBytes,
      current: currentBytes,
      delta,
    };
    if (delta > toleranceBytes) {
      comparison.violations.push({ ...record, allowed: baselineBytes + toleranceBytes });
    } else if (delta < 0) {
      comparison.reductions.push(record);
    } else {
      comparison.unchanged.push(record);
    }
  }

  for (const key of ['reductions', 'unchanged', 'violations']) {
    comparison[key].sort((left, right) => (
      compareText(left.file, right.file)
      || compareText(left.metric, right.metric)
    ));
  }
  return comparison;
}
