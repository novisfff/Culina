import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const REQUIRED_VIEWPORTS = [
  '375x812',
  '390x844',
  '430x932',
  '768x1024',
  '1024x768',
  '1440x900',
];

function nonEmpty(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function addMissing(missing, condition, field) {
  if (!condition) missing.push(field);
}

export function checkReleaseEvidence({ manifest, budgetResult, viewportReport, requestReport, evidence } = {}) {
  const missing = [];
  const violations = [];

  addMissing(missing, manifest?.version === 1, 'manifest');
  addMissing(missing, Object.keys(manifest?.entries ?? {}).length > 0, 'manifest.entries');
  addMissing(missing, Array.isArray(manifest?.manifestErrors), 'manifest.manifestErrors');
  if ((manifest?.manifestErrors?.length ?? 0) > 0) violations.push('manifest contains errors');

  addMissing(missing, budgetResult && typeof budgetResult === 'object', 'budgetResult');
  addMissing(missing, Array.isArray(budgetResult?.violations), 'budgetResult.violations');
  addMissing(missing, Array.isArray(budgetResult?.manifestErrors), 'budgetResult.manifestErrors');
  if ((budgetResult?.violations?.length ?? 0) > 0) violations.push('bundle budget contains violations');
  if ((budgetResult?.manifestErrors?.length ?? 0) > 0) violations.push('bundle budget contains manifest errors');

  addMissing(missing, viewportReport?.browserRun === true, 'viewportReport.browserRun');
  for (const viewport of REQUIRED_VIEWPORTS) {
    const result = viewportReport?.viewports?.[viewport];
    addMissing(missing, Boolean(result), `viewportReport.viewports.${viewport}`);
    if (result && result.status !== 'passed') violations.push(`viewport ${viewport} did not pass`);
  }

  addMissing(missing, Number.isInteger(requestReport?.requestCount), 'requestReport.requestCount');
  addMissing(missing, requestReport?.requestCount >= 0, 'requestReport.requestCount');
  addMissing(missing, typeof requestReport?.cacheReuse === 'boolean', 'requestReport.cacheReuse');
  addMissing(missing, Number.isFinite(requestReport?.longTaskMs), 'requestReport.longTaskMs');

  addMissing(missing, nonEmpty(evidence?.buildCommit), 'evidence.buildCommit');
  addMissing(missing, nonEmpty(evidence?.nodeVersion), 'evidence.nodeVersion');
  addMissing(missing, nonEmpty(evidence?.viteVersion), 'evidence.viteVersion');
  addMissing(missing, nonEmpty(evidence?.rollbackCommand), 'evidence.rollbackCommand');
  if (nonEmpty(evidence?.buildCommit) && manifest?.sourceCommit && evidence.buildCommit !== manifest.sourceCommit) {
    violations.push('build commit does not match manifest sourceCommit');
  }

  return { ok: missing.length === 0 && violations.length === 0, missing: missing.sort(), violations: violations.sort() };
}

function readJson(file) {
  if (!file || !existsSync(file)) throw new Error(`missing JSON file: ${file ?? ''}`);
  return JSON.parse(readFileSync(file, 'utf8'));
}

function parseArguments(argv) {
  const options = {};
  for (const argument of argv) {
    const [name, value] = argument.split('=', 2);
    if (name === '--manifest') options.manifest = value;
    else if (name === '--budget-result') options.budgetResult = value;
    else if (name === '--viewport-report') options.viewportReport = value;
    else if (name === '--request-report') options.requestReport = value;
    else if (name === '--evidence') options.evidence = value;
    else if (name === '--result') options.result = value;
    else throw new Error(`unknown argument: ${argument}`);
  }
  return options;
}

async function runCli() {
  const options = parseArguments(process.argv.slice(2));
  const result = checkReleaseEvidence({
    manifest: readJson(options.manifest),
    budgetResult: readJson(options.budgetResult),
    viewportReport: readJson(options.viewportReport),
    requestReport: readJson(options.requestReport),
    evidence: readJson(options.evidence),
  });
  if (options.result) writeFileSync(path.resolve(options.result), `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  for (const item of result.missing) process.stderr.write(`[missing] ${item}\n`);
  for (const item of result.violations) process.stderr.write(`[violation] ${item}\n`);
  process.exitCode = result.ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli().catch((error) => {
    process.stderr.write(`${error.stack ?? error.message}\n`);
    process.exitCode = 1;
  });
}
