import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';


const DEBT_FIELDS = Object.freeze([
  ['important', 'important'],
  ['businessSpecificity', 'business-specificity'],
  ['attributeSelector', 'attribute-selector'],
  ['noncanonicalMedia', 'noncanonical-media'],
]);
const SEMANTIC_MEDIA_FEATURES = Object.freeze([
  'forced-colors',
  'hover',
  'orientation',
  'pointer',
  'prefers-color-scheme',
  'prefers-contrast',
  'prefers-reduced-motion',
]);
const CANONICAL_MEDIA = new Set([
  '(max-width: 767px)',
  '(min-width: 768px)',
  '(max-width: 1023px)',
  '(min-width: 1024px)',
  '(min-width: 768px) and (max-width: 1023px)',
]);


function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
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


function lineFor(content, offset) {
  return content.slice(0, offset).split('\n').length;
}


function matchingParenthesis(content, open) {
  let depth = 0;
  for (let index = open; index < content.length; index += 1) {
    if (content[index] === '(') depth += 1;
    else if (content[index] === ')') {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return content.length - 1;
}


function splitTopLevel(content, separator = ',') {
  const parts = [];
  let start = 0;
  let parentheses = 0;
  let brackets = 0;
  for (let index = 0; index < content.length; index += 1) {
    const char = content[index];
    if (char === '(') parentheses += 1;
    else if (char === ')') parentheses = Math.max(0, parentheses - 1);
    else if (char === '[') brackets += 1;
    else if (char === ']') brackets = Math.max(0, brackets - 1);
    else if (char === separator && parentheses === 0 && brackets === 0) {
      parts.push(content.slice(start, index).trim());
      start = index + 1;
    }
  }
  parts.push(content.slice(start).trim());
  return parts.filter(Boolean);
}


function addSpecificity(left, right) {
  return {
    ids: left.ids + right.ids,
    classes: left.classes + right.classes,
    elements: left.elements + right.elements,
  };
}


function maxSpecificity(entries) {
  return entries.reduce((best, entry) => {
    if (entry.ids !== best.ids) return entry.ids > best.ids ? entry : best;
    if (entry.classes !== best.classes) return entry.classes > best.classes ? entry : best;
    return entry.elements > best.elements ? entry : best;
  }, { ids: 0, classes: 0, elements: 0 });
}


function selectorDepth(selector) {
  let depth = 0;
  let inCompound = false;
  let parentheses = 0;
  let brackets = 0;
  for (let index = 0; index < selector.length; index += 1) {
    const char = selector[index];
    if (char === '(') parentheses += 1;
    else if (char === ')') parentheses = Math.max(0, parentheses - 1);
    else if (char === '[') brackets += 1;
    else if (char === ']') brackets = Math.max(0, brackets - 1);
    if (parentheses > 0 || brackets > 0) {
      if (!/\s/.test(char)) inCompound = true;
      continue;
    }
    const combinator = char === '>' || char === '+' || char === '~' || /\s/.test(char);
    if (combinator) {
      if (inCompound) {
        depth += 1;
        inCompound = false;
      }
    } else if (char !== ',') inCompound = true;
  }
  return depth + (inCompound ? 1 : 0);
}


function rawSpecificity(selector) {
  let source = selector;
  let functional = { ids: 0, classes: 0, elements: 0 };
  const functionalPattern = /:(where|is|not|has)\(/i;
  let match = functionalPattern.exec(source);
  while (match) {
    const open = (match.index ?? 0) + match[0].length - 1;
    const close = matchingParenthesis(source, open);
    const name = match[1].toLowerCase();
    if (name !== 'where') {
      const options = splitTopLevel(source.slice(open + 1, close)).map(rawSpecificity);
      functional = addSpecificity(functional, maxSpecificity(options));
    }
    source = `${source.slice(0, match.index)}${' '.repeat(close - (match.index ?? 0) + 1)}${source.slice(close + 1)}`;
    match = functionalPattern.exec(source);
  }

  const attributes = source.match(/\[[^\]]+\]/g)?.length ?? 0;
  source = source.replace(/\[[^\]]+\]/g, ' ');
  const ids = source.match(/#[a-zA-Z_][\w-]*/g)?.length ?? 0;
  const classes = source.match(/\.[a-zA-Z_][\w-]*/g)?.length ?? 0;
  const pseudoElements = source.match(/::[a-zA-Z_][\w-]*/g)?.length ?? 0;
  source = source.replace(/::[a-zA-Z_][\w-]*/g, ' ');
  const pseudoClasses = source.match(/:(?!:)[a-zA-Z_][\w-]*(?:\([^)]*\))?/g)?.length ?? 0;
  source = source
    .replace(/#[a-zA-Z_][\w-]*/g, ' ')
    .replace(/\.[a-zA-Z_][\w-]*/g, ' ')
    .replace(/:(?!:)[a-zA-Z_][\w-]*(?:\([^)]*\))?/g, ' ')
    .replace(/[&*]/g, ' ');
  const elements = source.match(/(?:^|[\s>+~|])([a-zA-Z][\w-]*)/g)?.length ?? 0;
  return addSpecificity(functional, {
    ids,
    classes: classes + attributes + pseudoClasses,
    elements: elements + pseudoElements,
  });
}


export function scanSpecificity(selector) {
  return { ...rawSpecificity(selector), depth: selectorDepth(selector) };
}


export function normalizeMediaPrelude(prelude) {
  return prelude
    .replace(/^\s*@media\s*/i, '')
    .toLowerCase()
    .replace(/(-?\d+)\.0+(?=px\b)/g, '$1')
    .replace(/\s*:\s*/g, ': ')
    .replace(/\(\s*/g, '(')
    .replace(/\s*\)/g, ')')
    .replace(/\s*,\s*/g, ', ')
    .replace(/\s+/g, ' ')
    .trim();
}


export function normalizeMediaQuery(prelude) {
  const normalized = normalizeMediaPrelude(prelude);
  if (normalized === 'print' || normalized.startsWith('print and ')) return 'semantic';
  if (SEMANTIC_MEDIA_FEATURES.some((feature) => normalized.includes(`(${feature}:`))) return 'semantic';
  return CANONICAL_MEDIA.has(normalized) ? 'canonical' : 'noncanonical';
}


function rulePreludes(masked) {
  const rules = [];
  let start = 0;
  for (let index = 0; index < masked.length; index += 1) {
    const char = masked[index];
    if (char === '{') {
      const prelude = masked.slice(start, index).trim();
      const offset = start + masked.slice(start, index).search(/\S|$/);
      if (prelude) rules.push({ prelude, offset });
      start = index + 1;
    } else if (char === '}' || char === ';') start = index + 1;
  }
  return rules;
}


function debtEntry(metric, selectorOrValue, { file, owner }, content, offset) {
  return {
    metric,
    selectorOrValue,
    file,
    owner,
    line: lineFor(content, offset),
  };
}


export function scanCssDebtContent(content, {
  file = 'fixture.css',
  owner = 'unknown',
} = {}) {
  const masked = maskCommentsAndStrings(content);
  const result = {
    important: [],
    businessSpecificity: [],
    attributeSelector: [],
    noncanonicalMedia: [],
    semanticMedia: [],
    mediaTotal: 0,
  };
  for (const match of masked.matchAll(/!\s*important\b/gi)) {
    result.important.push(debtEntry('important', '!important', { file, owner }, content, match.index ?? 0));
  }
  for (const { prelude, offset } of rulePreludes(masked)) {
    if (/^@media\b/i.test(prelude)) {
      result.mediaTotal += 1;
      const normalized = normalizeMediaPrelude(prelude);
      const classification = normalizeMediaQuery(prelude);
      if (classification === 'noncanonical') {
        result.noncanonicalMedia.push(debtEntry('noncanonical-media', normalized, { file, owner }, content, offset));
      } else if (classification === 'semantic') {
        result.semanticMedia.push(debtEntry('semantic-media', normalized, { file, owner }, content, offset));
      }
      continue;
    }
    if (prelude.startsWith('@')) continue;
    for (const selector of splitTopLevel(prelude)) {
      const specificity = scanSpecificity(selector);
      if (specificity.depth >= 3) {
        result.businessSpecificity.push({
          ...debtEntry('business-specificity', selector, { file, owner }, content, offset),
          specificity,
        });
      }
      if (selector.includes('[')) {
        result.attributeSelector.push(debtEntry('attribute-selector', selector, { file, owner }, content, offset));
      }
    }
  }
  return result;
}


function debtEntries(debt) {
  return Object.values(debt).filter(Array.isArray).flat();
}


function countByOwner(debt, baseline = {}) {
  const owners = new Set([
    ...debtEntries(debt).map((entry) => entry.owner),
    ...debtEntries(baseline).map((entry) => entry.owner),
  ]);
  return Object.fromEntries([...owners].sort(compareText).map((owner) => [owner, {
    important: debt.important.filter((entry) => entry.owner === owner).length,
    businessSpecificity: debt.businessSpecificity.filter((entry) => entry.owner === owner).length,
    attributeSelector: debt.attributeSelector.filter((entry) => entry.owner === owner).length,
    noncanonicalMedia: debt.noncanonicalMedia.filter((entry) => entry.owner === owner).length,
    semanticMedia: debt.semanticMedia.filter((entry) => entry.owner === owner).length,
  }]));
}


function matchingException(entry, exceptions) {
  return exceptions.some((exception) => (
    exception.metric === entry.metric
    && exception.selectorOrValue === entry.selectorOrValue
    && exception.owner === entry.owner
  ));
}


export function compareCssDebt(current, baseline, exceptions = []) {
  const reductions = [];
  const violations = [];
  for (const [field, metric] of DEBT_FIELDS) {
    const currentEntries = current[field] ?? [];
    const baselineValue = baseline[field] ?? [];
    const baselineCount = Array.isArray(baselineValue) ? baselineValue.length : baselineValue;
    const delta = currentEntries.length - baselineCount;
    if (delta < 0) reductions.push({ metric, baseline: baselineCount, current: currentEntries.length, delta });
    if (delta > 0) {
      const additions = currentEntries.slice(baselineCount);
      for (const entry of additions) {
        if (!matchingException(entry, exceptions)) violations.push({ ...entry, baseline: baselineCount });
      }
    }
  }
  if (Number.isInteger(baseline.mediaTotal)) {
    const delta = (current.mediaTotal ?? 0) - baseline.mediaTotal;
    if (delta < 0) reductions.push({ metric: 'media', baseline: baseline.mediaTotal, current: current.mediaTotal ?? 0, delta });
    else if (delta > 0) violations.push({
      metric: 'media',
      selectorOrValue: 'all @media blocks',
      file: 'frontend/src/styles',
      owner: 'responsive',
      line: 1,
      baseline: baseline.mediaTotal,
      current: current.mediaTotal ?? 0,
    });
  }
  reductions.sort((left, right) => compareText(left.metric, right.metric));
  violations.sort((left, right) => (
    compareText(left.metric, right.metric)
    || compareText(left.file, right.file)
    || left.line - right.line
    || compareText(left.selectorOrValue, right.selectorOrValue)
  ));
  return { violations, reductions, byOwner: countByOwner(current, baseline) };
}


async function listCssFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return listCssFiles(fullPath);
    return entry.isFile() && entry.name.endsWith('.css') ? [fullPath] : [];
  }));
  return nested.flat().sort(compareText);
}


function mergeDebt(target, source) {
  for (const field of [...DEBT_FIELDS.map(([name]) => name), 'semanticMedia']) target[field].push(...source[field]);
}


export async function scanCssDebt({ rootDir, stylesDir, ownership }) {
  const result = {
    important: [],
    businessSpecificity: [],
    attributeSelector: [],
    noncanonicalMedia: [],
    semanticMedia: [],
    mediaTotal: 0,
    lines: 0,
    legacyLines: 0,
  };
  const ownersByFile = new Map();
  for (const entry of ownership?.owners ?? ownership?.scopes ?? []) {
    for (const source of entry.sources ?? []) {
      if (!ownersByFile.has(source)) ownersByFile.set(source, entry.id);
    }
  }
  for (const cssFile of await listCssFiles(stylesDir)) {
    const file = path.relative(rootDir, cssFile).split(path.sep).join('/');
    const content = await readFile(cssFile, 'utf8');
    const scanned = scanCssDebtContent(content, {
      file,
      owner: ownersByFile.get(file) ?? 'unknown',
    });
    mergeDebt(result, scanned);
    result.mediaTotal += scanned.mediaTotal;
    const lines = content.split('\n').length;
    result.lines += lines;
    const ownedResponsive = /\/(?:family|home|recipe|meal|eat|ingredients|food|inventory|shell)-responsive\.css$/.test(file)
      || file.endsWith('/responsive.css');
    if (!ownedResponsive) result.legacyLines += lines;
  }
  return result;
}
