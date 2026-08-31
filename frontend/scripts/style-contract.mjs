import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';


const REQUIRED_ALIAS_FIELDS = Object.freeze([
  'target', 'owner', 'reason', 'introducedAt', 'expiresAt', 'replacement', 'test',
]);
const REQUIRED_RUNTIME_FIELDS = Object.freeze([
  'owner', 'source', 'fallback', 'consumers', 'introducedAt', 'expiresAt', 'test',
]);
const SOURCE_EXTENSIONS = new Set(['.css', '.js', '.jsx', '.ts', '.tsx']);
const REQUIRED_EXCEPTION_FIELDS = Object.freeze([
  'metric', 'selectorOrValue', 'owner', 'reason', 'introducedAt', 'expiresAt',
  'replacement', 'test', 'consumers',
]);


function assertObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
}


function assertFields(entry, fields, label) {
  assertObject(entry, label);
  for (const field of fields) {
    const value = entry[field];
    if (value === undefined || value === null || value === '' || (Array.isArray(value) && value.length === 0)) {
      throw new Error(`${label} requires ${field}`);
    }
  }
}


function validateDate(value, label) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) {
    throw new Error(`${label} must be an ISO date`);
  }
}


export function validateRuntimeVariable(entry, name = 'runtime variable') {
  assertFields(entry, REQUIRED_RUNTIME_FIELDS, name);
  if (!Array.isArray(entry.consumers)) throw new Error(`${name} consumers must be an array`);
  validateDate(entry.introducedAt, `${name}.introducedAt`);
  validateDate(entry.expiresAt, `${name}.expiresAt`);
  return entry;
}


function validateAlias(entry, name) {
  assertFields(entry, REQUIRED_ALIAS_FIELDS, name);
  validateDate(entry.introducedAt, `${name}.introducedAt`);
  validateDate(entry.expiresAt, `${name}.expiresAt`);
}


function validateContract(contract) {
  assertObject(contract, 'style token contract');
  if (contract.version !== 1) throw new Error('style token contract version must be 1');
  if (typeof contract.canonicalSource !== 'string' || !contract.canonicalSource.endsWith('.css')) {
    throw new Error('style token contract canonicalSource must be a CSS path');
  }
  for (const section of ['tokens', 'aliases', 'runtimeVariables']) {
    assertObject(contract[section], `style token contract ${section}`);
  }
  for (const [name, entry] of Object.entries(contract.tokens)) {
    if (!name.startsWith('--')) throw new Error(`invalid canonical token name: ${name}`);
    assertFields(entry, ['category', 'value', 'source', 'consumers'], `token ${name}`);
    if (entry.source !== contract.canonicalSource) {
      throw new Error(`token ${name} source must equal canonicalSource`);
    }
  }
  for (const [name, entry] of Object.entries(contract.aliases)) validateAlias(entry, `alias ${name}`);
  for (const [name, entry] of Object.entries(contract.runtimeVariables)) validateRuntimeVariable(entry, `runtime variable ${name}`);
  return contract;
}


export async function loadStyleTokenContract(contractPath) {
  const content = await readFile(contractPath, 'utf8');
  let contract;
  try {
    contract = JSON.parse(content);
  } catch (error) {
    throw new Error(`invalid style token contract JSON: ${error.message}`);
  }
  return validateContract(contract);
}


export async function loadStyleExceptions(exceptionsPath, {
  today = new Date().toISOString().slice(0, 10),
} = {}) {
  const content = await readFile(exceptionsPath, 'utf8');
  let registry;
  try {
    registry = JSON.parse(content);
  } catch (error) {
    throw new Error(`invalid style exceptions JSON: ${error.message}`);
  }
  if (!registry || typeof registry !== 'object' || registry.version !== 1) {
    throw new Error('style exceptions version must be 1');
  }
  if (!Array.isArray(registry.exceptions)) {
    throw new Error('style exceptions must be an array');
  }
  registry.exceptions.forEach((entry, index) => {
    const label = `style exception ${index}`;
    assertFields(entry, REQUIRED_EXCEPTION_FIELDS, label);
    if (!Array.isArray(entry.consumers) || entry.consumers.length === 0) {
      throw new Error(`${label} consumers must be a non-empty array`);
    }
    validateDate(entry.introducedAt, `${label}.introducedAt`);
    validateDate(entry.expiresAt, `${label}.expiresAt`);
    if (entry.allowedCount !== undefined && (!Number.isInteger(entry.allowedCount) || entry.allowedCount < 0)) {
      throw new Error(`${label}.allowedCount must be a non-negative integer`);
    }
    if (isExpired(entry.expiresAt, today)) {
      throw new Error(`${label} expired on ${entry.expiresAt}`);
    }
  });
  return registry.exceptions;
}


async function listSourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return listSourceFiles(fullPath);
    return entry.isFile() && SOURCE_EXTENSIONS.has(path.extname(entry.name)) ? [fullPath] : [];
  }));
  return nested.flat().sort();
}


function maskCommentsAndStrings(content) {
  const chars = [...content];
  let state = 'code';
  let quote = '';
  for (let index = 0; index < chars.length; index += 1) {
    const char = chars[index];
    const next = chars[index + 1];
    if (state === 'comment') {
      if (char === '*' && next === '/') {
        chars[index] = ' ';
        chars[index + 1] = ' ';
        index += 1;
        state = 'code';
      } else if (char !== '\n') chars[index] = ' ';
      continue;
    }
    if (state === 'string') {
      if (char === '\\') {
        chars[index] = ' ';
        if (chars[index + 1] !== '\n') chars[index + 1] = ' ';
        index += 1;
      } else if (char === quote) {
        chars[index] = ' ';
        state = 'code';
      } else if (char !== '\n') chars[index] = ' ';
      continue;
    }
    if (char === '/' && next === '*') {
      chars[index] = ' ';
      chars[index + 1] = ' ';
      index += 1;
      state = 'comment';
    } else if (char === '"' || char === "'") {
      chars[index] = ' ';
      quote = char;
      state = 'string';
    }
  }
  return chars.join('');
}


function locationFor(content, index) {
  const before = content.slice(0, index);
  const lines = before.split('\n');
  return { line: lines.length, column: lines.at(-1).length + 1 };
}


function normalizeFile(rootDir, file) {
  return path.relative(rootDir, file).split(path.sep).join('/');
}


function isExpired(expiresAt, today) {
  return expiresAt < today;
}


function classifyReference({ variable, fallback, contract, definitions, today }) {
  const token = contract.tokens[variable];
  if (token) return { classification: 'canonical' };
  const alias = contract.aliases[variable];
  if (alias) return {
    classification: isExpired(alias.expiresAt, today) ? 'expired-alias' : 'alias-allowed',
    owner: alias.owner,
    expiry: alias.expiresAt,
  };
  const runtime = contract.runtimeVariables[variable];
  if (runtime) return {
    classification: isExpired(runtime.expiresAt, today) ? 'expired-runtime' : 'runtime-allowed',
    owner: runtime.owner,
    expiry: runtime.expiresAt,
  };
  if (definitions.has(variable)) return { classification: 'local-definition' };
  if (fallback !== undefined) return { classification: 'fallback-safe' };
  return { classification: 'undefined' };
}


function cssDefinitions(content, file, rootDir) {
  const masked = maskCommentsAndStrings(content);
  const definitions = [];
  const regex = /(^|[;{]\s*)(--[a-zA-Z0-9_-]+)\s*:\s*([^;}]+)/gm;
  for (const match of masked.matchAll(regex)) {
    const variableOffset = match[0].indexOf(match[2]);
    const index = (match.index ?? 0) + variableOffset;
    const valueOffset = match[0].indexOf(':', variableOffset + match[2].length) + 1;
    const originalValue = content.slice(
      (match.index ?? 0) + valueOffset,
      (match.index ?? 0) + match[0].length,
    );
    definitions.push({
      variable: match[2],
      value: originalValue.trim().replace(/\s+/g, ' '),
      file: normalizeFile(rootDir, file),
      ...locationFor(content, index),
      start: match.index ?? 0,
      end: (match.index ?? 0) + match[0].length,
    });
  }
  return { masked, definitions };
}


function cssReferences(content, masked, definitionEntries, file, rootDir) {
  const referenceSource = [...masked];
  for (const definition of definitionEntries) {
    for (let index = definition.start; index < definition.end; index += 1) {
      if (referenceSource[index] !== '\n') referenceSource[index] = ' ';
    }
  }
  const references = [];
  const regex = /var\(\s*(--[a-zA-Z0-9_-]+)\s*(?:,([^)]*))?\)/g;
  for (const match of referenceSource.join('').matchAll(regex)) {
    const variableOffset = match[0].indexOf(match[1]);
    const index = (match.index ?? 0) + variableOffset;
    references.push({
      variable: match[1],
      fallback: match[2]?.trim(),
      file: normalizeFile(rootDir, file),
      ...locationFor(content, index),
    });
  }
  return references;
}


function runtimeReferences(content, file, rootDir) {
  const references = [];
  const regex = /(['"])(--[a-zA-Z0-9_-]+)\1\s*(?::|,|\])/g;
  for (const match of content.matchAll(regex)) {
    const index = (match.index ?? 0) + match[0].indexOf(match[2]);
    references.push({
      variable: match[2],
      file: normalizeFile(rootDir, file),
      ...locationFor(content, index),
      inline: true,
    });
  }
  return references;
}


export async function scanCssTokens({ rootDir, stylesDir, contract, today = new Date().toISOString().slice(0, 10) }) {
  validateContract(contract);
  const frontendSrc = path.dirname(stylesDir);
  const files = await listSourceFiles(frontendSrc);
  const cssRecords = [];
  const definitions = [];

  for (const file of files.filter((candidate) => candidate.endsWith('.css'))) {
    const content = await readFile(file, 'utf8');
    const record = cssDefinitions(content, file, rootDir);
    definitions.push(...record.definitions);
    cssRecords.push({ file, content, ...record });
  }

  const definitionNames = new Set(definitions.map((entry) => entry.variable));
  const rawReferences = cssRecords.flatMap(({ content, masked, definitions: entries, file }) => (
    cssReferences(content, masked, entries, file, rootDir)
  ));
  for (const file of files.filter((candidate) => !candidate.endsWith('.css'))) {
    const content = await readFile(file, 'utf8');
    rawReferences.push(...runtimeReferences(content, file, rootDir));
  }

  const references = rawReferences.map((entry) => ({
    ...entry,
    ...classifyReference({
      variable: entry.variable,
      fallback: entry.fallback,
      contract,
      definitions: definitionNames,
      today,
    }),
  }));

  const drift = [];
  const canonicalDefinitions = new Map(definitions
    .filter((entry) => entry.file === contract.canonicalSource)
    .map((entry) => [entry.variable, entry]));
  for (const [variable, tokenEntry] of Object.entries(contract.tokens)) {
    const definition = canonicalDefinitions.get(variable);
    if (!definition) {
      drift.push({ variable, classification: 'missing-definition', expected: tokenEntry.value });
    } else if (definition.value !== tokenEntry.value.replace(/\s+/g, ' ')) {
      drift.push({
        variable,
        classification: 'definition-drift',
        expected: tokenEntry.value,
        actual: definition.value,
        file: definition.file,
        line: definition.line,
        column: definition.column,
      });
    }
  }
  for (const reference of references) {
    if (['fallback-safe', 'expired-alias', 'expired-runtime'].includes(reference.classification)) {
      drift.push({
        ...reference,
        classification: reference.classification === 'fallback-safe'
          ? 'noncanonical-reference'
          : reference.classification,
      });
    }
  }

  const undefinedVariables = references.filter((entry) => entry.classification === 'undefined');
  const sortByLocation = (left, right) => (
    (left.file ?? '').localeCompare(right.file ?? '')
    || (left.line ?? 0) - (right.line ?? 0)
    || (left.column ?? 0) - (right.column ?? 0)
    || left.variable.localeCompare(right.variable)
  );
  definitions.sort(sortByLocation);
  references.sort(sortByLocation);
  drift.sort(sortByLocation);
  undefinedVariables.sort(sortByLocation);
  return { definitions, references, drift, undefinedVariables };
}


function parseCliArguments(argv) {
  const options = { format: 'json', mode: 'report' };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--format') options.format = argv[++index];
    else if (argument === '--output') options.output = argv[++index];
    else if (argument.startsWith('--mode=')) options.mode = argument.slice('--mode='.length);
    else throw new Error(`unknown argument: ${argument}`);
  }
  if (!['json', 'markdown'].includes(options.format)) throw new Error(`unsupported format: ${options.format}`);
  if (!['report', 'ratchet', 'target'].includes(options.mode)) throw new Error(`unsupported mode: ${options.mode}`);
  return options;
}


function allowedCount(exceptions, metric) {
  const entry = exceptions.find((candidate) => candidate.metric === metric && Number.isInteger(candidate.allowedCount));
  if (!entry) throw new Error(`style exception ${metric} requires allowedCount`);
  return entry.allowedCount;
}


async function runCli() {
  const options = parseCliArguments(process.argv.slice(2));
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const frontendDir = path.dirname(scriptDir);
  const rootDir = path.dirname(frontendDir);
  const contract = await loadStyleTokenContract(path.join(scriptDir, 'style-token-contract.json'));
  const result = await scanCssTokens({
    rootDir,
    stylesDir: path.join(frontendDir, 'src', 'styles'),
    contract,
  });
  const tokenViolations = [
    ...result.undefinedVariables,
    ...result.drift.filter((entry) => ['expired-alias', 'expired-runtime', 'definition-drift', 'missing-definition'].includes(entry.classification)),
  ];
  const exceptions = await loadStyleExceptions(path.join(scriptDir, 'style-exceptions.json'));
  const { createDeadSelectorReport, loadStyleOwnership } = await import('./dead-selectors.mjs');
  const ownership = await loadStyleOwnership(path.join(scriptDir, 'style-ownership.json'));
  const selectorReport = await createDeadSelectorReport({ rootDir, frontendDir, ownership });
  const selectorSummary = Object.fromEntries(
    ['unused', 'duplicate', 'ownerMissing', 'dynamic'].map((metric) => [metric, selectorReport[metric].length]),
  );
  const selectorViolations = Object.entries(selectorSummary)
    .filter(([metric, count]) => ownership.baseline && count > (ownership.baseline[metric] ?? 0))
    .map(([metric, count]) => ({
      classification: 'selector-ratchet-increase',
      metric,
      baseline: ownership.baseline[metric] ?? 0,
      current: count,
    }));
  const { assertCssLayerOrder } = await import('./css-layer-contract.mjs');
  const layerResult = assertCssLayerOrder(
    await readFile(path.join(frontendDir, 'src', 'styles.css'), 'utf8'),
  );
  const layerViolations = layerResult.violations.map((message) => ({
    classification: 'cascade-layer-contract',
    message,
  }));
  const { compareCssDebt, scanCssDebt } = await import('./css-ratchet.mjs');
  const cssDebt = await scanCssDebt({
    rootDir,
    stylesDir: path.join(frontendDir, 'src', 'styles'),
    ownership,
  });
  const debtComparison = compareCssDebt(cssDebt, {
    important: allowedCount(exceptions, 'important'),
    businessSpecificity: allowedCount(exceptions, 'business-specificity'),
    attributeSelector: allowedCount(exceptions, 'attribute-selector'),
    noncanonicalMedia: allowedCount(exceptions, 'noncanonical-media'),
    mediaTotal: 180,
  }, exceptions);
  const cssTargetViolations = [];
  const cssTargets = [
    ['legacy-lines', cssDebt.legacyLines, 67_000],
    ['important', cssDebt.important.length, 650],
    ['media', cssDebt.mediaTotal, 180],
    ['token-drift', result.drift.length, 25],
    ['duplicate-selector', selectorSummary.duplicate, 1_100],
  ];
  for (const [metric, current, target] of cssTargets) {
    if (current > target) cssTargetViolations.push({
      classification: 'css-phase-one-target', metric, current, target,
    });
  }
  for (const entry of cssDebt.semanticMedia) {
    if (entry.owner === 'unknown') cssTargetViolations.push({
      classification: 'semantic-media-missing-owner', ...entry,
    });
  }
  const violations = [
    ...tokenViolations,
    ...selectorViolations,
    ...layerViolations,
    ...(options.mode === 'report' ? [] : [...debtComparison.violations, ...cssTargetViolations]),
  ];
  const report = {
    tokens: {
      definitions: result.definitions.length,
      references: result.references.length,
      drift: result.drift.length,
      undefinedVariables: result.undefinedVariables.length,
    },
    selectors: selectorSummary,
    css: {
      lines: cssDebt.lines,
      legacyLines: cssDebt.legacyLines,
      important: cssDebt.important.length,
      media: cssDebt.mediaTotal,
      businessSpecificity: cssDebt.businessSpecificity.length,
      attributeSelectors: cssDebt.attributeSelector.length,
      noncanonicalMedia: cssDebt.noncanonicalMedia.length,
      semanticMedia: cssDebt.semanticMedia.length,
      reductions: debtComparison.reductions,
      byOwner: debtComparison.byOwner,
    },
    layers: layerResult.layers,
    exceptions: exceptions.length,
    violations,
  };
  let output;
  if (options.format === 'markdown') {
    output = [
      '# CSS governance report',
      '',
      `- CSS lines: ${report.css.lines}`,
      `- legacy CSS lines: ${report.css.legacyLines}`,
      `- !important: ${report.css.important}`,
      `- @media: ${report.css.media}`,
      `- deep business selectors: ${report.css.businessSpecificity}`,
      `- attribute selectors: ${report.css.attributeSelectors}`,
      `- noncanonical media: ${report.css.noncanonicalMedia}`,
      `- semantic media: ${report.css.semanticMedia}`,
      `- token definitions: ${report.tokens.definitions}`,
      `- token references: ${report.tokens.references}`,
      `- token drift: ${report.tokens.drift}`,
      `- undefined variables: ${report.tokens.undefinedVariables}`,
      `- unused selector candidates: ${report.selectors.unused}`,
      `- duplicate selectors: ${report.selectors.duplicate}`,
      `- selectors missing owner: ${report.selectors.ownerMissing}`,
      `- dynamic selectors: ${report.selectors.dynamic}`,
      `- cascade layers: ${report.layers.join(' > ')}`,
      `- active exceptions: ${report.exceptions}`,
      `- violations: ${report.violations.length}`,
      '',
    ].join('\n');
  } else {
    output = `${JSON.stringify(report, null, 2)}\n`;
  }
  if (options.output) await writeFile(path.resolve(process.cwd(), options.output), output, 'utf8');
  else process.stdout.write(output);
  if (violations.length > 0) process.exitCode = 1;
}


if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await runCli();
}
