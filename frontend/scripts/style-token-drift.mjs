import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

export {
  loadStyleExceptions,
  loadStyleTokenContract,
  scanCssTokens,
  validateRuntimeVariable,
} from './style-contract.mjs';


export const DEFAULT_PATTERNS = Object.freeze([
  { id: 'radius-13px', label: 'border-radius: 13px', regex: /border-radius:\s*13px/g },
  { id: 'radius-17px', label: 'border-radius: 17px', regex: /border-radius:\s*17px/g },
  { id: 'black-rgba', label: 'rgba(0, 0, 0, ...)', regex: /rgba\(0,\s*0,\s*0,\s*[^)]+\)/g },
]);


async function listCssFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return listCssFiles(fullPath);
    return entry.isFile() && entry.name.endsWith('.css') ? [fullPath] : [];
  }));
  return nested.flat().sort();
}


function relativeCssPath(rootDir, file) {
  return path.relative(rootDir, file).split(path.sep).join('/');
}


function lineNumberForIndex(content, index) {
  return content.slice(0, index).split('\n').length;
}


export async function scanStyleTokenDrift({
  rootDir,
  stylesDir,
  patterns = DEFAULT_PATTERNS,
}) {
  const files = await listCssFiles(stylesDir);
  const hits = [];
  const counts = {};

  for (const pattern of patterns) counts[pattern.id] = {};

  for (const file of files) {
    const content = await readFile(file, 'utf8');
    const relativeFile = relativeCssPath(rootDir, file);
    for (const pattern of patterns) {
      for (const match of content.matchAll(pattern.regex)) {
        hits.push({
          patternId: pattern.id,
          pattern: pattern.label,
          file: relativeFile,
          line: lineNumberForIndex(content, match.index ?? 0),
          value: match[0],
        });
        counts[pattern.id][relativeFile] = (counts[pattern.id][relativeFile] ?? 0) + 1;
      }
    }
  }

  return { files, hits, counts };
}


export function validateStyleTokenBaseline(baseline, patterns = DEFAULT_PATTERNS) {
  if (!baseline || typeof baseline !== 'object' || Array.isArray(baseline)) {
    throw new Error('style token baseline root must be an object');
  }
  if (baseline.version !== 1) {
    throw new Error('style token baseline version must be 1');
  }
  if (!baseline.allowedByRule || typeof baseline.allowedByRule !== 'object' || Array.isArray(baseline.allowedByRule)) {
    throw new Error('style token baseline allowedByRule must be an object');
  }

  const knownPatternIds = new Set(patterns.map((pattern) => pattern.id));
  for (const patternId of Object.keys(baseline.allowedByRule)) {
    if (!knownPatternIds.has(patternId)) {
      throw new Error(`style token baseline has unknown pattern id: ${patternId}`);
    }
  }
  for (const patternId of knownPatternIds) {
    const fileCounts = baseline.allowedByRule[patternId];
    if (!fileCounts || typeof fileCounts !== 'object' || Array.isArray(fileCounts)) {
      throw new Error(`style token baseline is missing rule: ${patternId}`);
    }
    for (const [file, count] of Object.entries(fileCounts)) {
      const normalized = path.posix.normalize(file);
      if (
        normalized !== file
        || !file.startsWith('src/styles/')
        || !file.endsWith('.css')
      ) {
        throw new Error(`style token baseline has invalid CSS path: ${file}`);
      }
      if (!Number.isInteger(count) || count < 0) {
        throw new Error(
          `style token baseline count must be a non-negative integer: ${patternId} ${file}`,
        );
      }
    }
  }
  return baseline;
}


export function compareStyleTokenBaseline(currentCounts, baseline) {
  const comparisons = [];
  const patternIds = new Set([
    ...Object.keys(currentCounts),
    ...Object.keys(baseline.allowedByRule),
  ]);

  for (const patternId of patternIds) {
    const currentFiles = currentCounts[patternId] ?? {};
    const baselineFiles = baseline.allowedByRule[patternId] ?? {};
    const files = new Set([...Object.keys(currentFiles), ...Object.keys(baselineFiles)]);
    for (const file of files) {
      const current = currentFiles[file] ?? 0;
      const allowed = baselineFiles[file] ?? 0;
      comparisons.push({
        patternId,
        file,
        baseline: allowed,
        current,
        delta: current - allowed,
      });
    }
  }

  comparisons.sort((left, right) => (
    left.patternId.localeCompare(right.patternId) || left.file.localeCompare(right.file)
  ));
  return {
    violations: comparisons.filter((item) => item.delta > 0),
    reductions: comparisons.filter((item) => item.delta < 0),
  };
}
