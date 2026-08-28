import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';


const REQUIRED_OWNERSHIP_FIELDS = Object.freeze([
  'selector', 'owner', 'source', 'consumers', 'sharedWith', 'dynamic', 'deleteWhen', 'test',
]);


function assertOwnershipEntry(entry, index) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    throw new Error(`selector ownership entry ${index} must be an object`);
  }
  for (const field of REQUIRED_OWNERSHIP_FIELDS) {
    if (entry[field] === undefined || entry[field] === null || entry[field] === '') {
      throw new Error(`selector ownership entry ${index} requires ${field}`);
    }
  }
  if (!Array.isArray(entry.consumers) || entry.consumers.length === 0) {
    throw new Error(`selector ownership entry ${index} consumers must be a non-empty array`);
  }
  if (!Array.isArray(entry.sharedWith)) {
    throw new Error(`selector ownership entry ${index} sharedWith must be an array`);
  }
  if (typeof entry.dynamic !== 'boolean') {
    throw new Error(`selector ownership entry ${index} dynamic must be a boolean`);
  }
}


export async function loadStyleOwnership(ownershipPath) {
  const content = await readFile(ownershipPath, 'utf8');
  let registry;
  try {
    registry = JSON.parse(content);
  } catch (error) {
    throw new Error(`invalid style ownership JSON: ${error.message}`);
  }
  if (!registry || typeof registry !== 'object' || registry.version !== 1) {
    throw new Error('style ownership version must be 1');
  }
  if (!Array.isArray(registry.selectors)) {
    throw new Error('style ownership selectors must be an array');
  }
  const ownership = new Map();
  registry.selectors.forEach((entry, index) => {
    assertOwnershipEntry(entry, index);
    if (ownership.has(entry.selector)) throw new Error(`duplicate selector ownership: ${entry.selector}`);
    ownership.set(entry.selector, entry);
  });
  ownership.scopes = Array.isArray(registry.owners) ? registry.owners : [];
  ownership.baseline = registry.baseline ?? null;
  return ownership;
}


function maskCssComments(content) {
  return content.replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, ' '));
}


function lineFor(content, index) {
  return content.slice(0, index).split('\n').length;
}


function normalizeFile(rootDir, file) {
  return path.relative(rootDir, file).split(path.sep).join('/');
}


function selectorAtoms(selectorText) {
  const atoms = new Set();
  for (const match of selectorText.matchAll(/\.[_a-zA-Z][-_a-zA-Z0-9]*/g)) atoms.add(match[0]);
  for (const match of selectorText.matchAll(/#[_a-zA-Z][-_a-zA-Z0-9]*/g)) atoms.add(match[0]);
  for (const match of selectorText.matchAll(/\[data-[^\]]+\]/g)) atoms.add(match[0]);
  return [...atoms];
}


function splitSelectorList(selectorGroup) {
  const selectors = [];
  let start = 0;
  let depth = 0;
  let quote = '';
  for (let index = 0; index < selectorGroup.length; index += 1) {
    const char = selectorGroup[index];
    if (quote) {
      if (char === '\\') index += 1;
      else if (char === quote) quote = '';
      continue;
    }
    if (char === '"' || char === "'") quote = char;
    else if (char === '(' || char === '[') depth += 1;
    else if (char === ')' || char === ']') depth = Math.max(0, depth - 1);
    else if (char === ',' && depth === 0) {
      selectors.push({ text: selectorGroup.slice(start, index), offset: start });
      start = index + 1;
    }
  }
  selectors.push({ text: selectorGroup.slice(start), offset: start });
  return selectors;
}


function atRuleRanges(masked) {
  const ranges = [];
  const regex = /@(media|supports|container)\s+([^{}]+)\{/g;
  for (const match of masked.matchAll(regex)) {
    const start = (match.index ?? 0) + match[0].length - 1;
    let depth = 1;
    let end = masked.length;
    for (let index = start + 1; index < masked.length; index += 1) {
      if (masked[index] === '{') depth += 1;
      else if (masked[index] === '}') depth -= 1;
      if (depth === 0) {
        end = index;
        break;
      }
    }
    ranges.push({
      start,
      end,
      context: `@${match[1]} ${match[2].trim().replace(/\s+/g, ' ')}`,
    });
  }
  return ranges;
}


async function readCssSelectors(cssFiles, rootDir) {
  const occurrences = [];
  for (const file of [...cssFiles].sort()) {
    const content = await readFile(file, 'utf8');
    const masked = maskCssComments(content);
    const contexts = atRuleRanges(masked);
    const blockRegex = /([^{}]+)\{/g;
    for (const block of masked.matchAll(blockRegex)) {
      const selectorGroup = block[1].trim();
      if (!selectorGroup || selectorGroup.startsWith('@') || /^\d+(?:\.\d+)?%$/.test(selectorGroup) || selectorGroup === 'from' || selectorGroup === 'to') {
        continue;
      }
      const groupStart = (block.index ?? 0) + block[0].indexOf(block[1]);
      const atRuleContext = contexts
        .filter((context) => groupStart > context.start && groupStart < context.end)
        .map((context) => context.context)
        .join(' > ');
      for (const { text: selectorPart, offset: selectorOffset } of splitSelectorList(block[1])) {
        const partOffset = selectorOffset;
        const atoms = selectorAtoms(selectorPart);
        const hasDynamicAttribute = /\[data-[^\]]+\]/.test(selectorPart);
        const ruleSelector = selectorPart.trim().replace(/\s+/g, ' ');
        for (const selector of atoms) {
          const atomOffset = selectorPart.indexOf(selector);
          occurrences.push({
            selector,
            file: normalizeFile(rootDir, file),
            line: lineFor(content, groupStart + partOffset + atomOffset),
            dynamicSyntax: hasDynamicAttribute,
            ruleSelector,
            atRuleContext,
          });
        }
      }
    }
  }
  return occurrences;
}


function kebabCase(value) {
  return value.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
}


async function readUsageEvidence(files) {
  const contents = await Promise.all([...files].sort().map((file) => readFile(file, 'utf8')));
  const source = contents.join('\n');
  const staticSelectors = new Set();
  const dynamicPrefixes = new Set();

  for (const match of source.matchAll(/(['"])([\s\S]*?)\1/g)) {
    const value = match[2];
    for (const token of value.split(/\s+/)) {
      const cleaned = token.replace(/^[^.#_a-zA-Z]+|[^-_a-zA-Z0-9]+$/g, '');
      if (!cleaned) continue;
      if (token.startsWith('.')) staticSelectors.add(`.${cleaned.replace(/^\./, '')}`);
      else if (token.startsWith('#')) staticSelectors.add(`#${cleaned.replace(/^#/, '')}`);
      else staticSelectors.add(`.${cleaned}`);
    }
  }
  for (const match of source.matchAll(/styles\.([a-zA-Z0-9_]+)/g)) {
    staticSelectors.add(`.${kebabCase(match[1])}`);
  }
  for (const match of source.matchAll(/`([^`]*\$\{[^`]*)`/g)) {
    const prefix = match[1].split('${')[0].split(/\s+/).at(-1);
    if (prefix) dynamicPrefixes.add(`.${prefix}`);
  }
  return { source, staticSelectors, dynamicPrefixes };
}


function isStaticallyUsed(selector, evidence) {
  if (evidence.staticSelectors.has(selector)) return true;
  return [...evidence.dynamicPrefixes].some((prefix) => selector.startsWith(prefix));
}


function uniqueBySelector(entries) {
  const seen = new Set();
  return entries.filter((entry) => {
    if (seen.has(entry.selector)) return false;
    seen.add(entry.selector);
    return true;
  });
}


function scopedOwnership(selector, occurrence, ownership) {
  const exact = ownership.get(selector);
  if (exact) return exact;
  const ruleAtoms = selectorAtoms(occurrence.ruleSelector).map((atom) => atom.replace(/^[.#]/, ''));
  const scopes = ownership.scopes ?? [];
  const matches = scopes.filter((scope) => (
    Array.isArray(scope.sources)
    && scope.sources.includes(occurrence.file)
    && Array.isArray(scope.prefixes)
    && scope.prefixes.some((prefix) => ruleAtoms.some((atom) => atom.startsWith(prefix)))
  ));
  if (matches.length !== 1) return null;
  return {
    selector,
    owner: matches[0].id,
    source: occurrence.file,
    consumers: ['owner scope registry'],
    sharedWith: [],
    dynamic: false,
    deleteWhen: 'No static or runtime consumer remains',
    test: 'frontend/scripts/dead-selectors.test.mjs',
  };
}


export async function scanSelectorUsage({
  rootDir,
  cssFiles,
  tsxFiles,
  e2eFiles,
  ownership = new Map(),
}) {
  const occurrences = await readCssSelectors(cssFiles, rootDir);
  const evidence = await readUsageEvidence([...tsxFiles, ...e2eFiles]);
  const bySelector = new Map();
  for (const occurrence of occurrences) {
    const entries = bySelector.get(occurrence.selector) ?? [];
    entries.push(occurrence);
    bySelector.set(occurrence.selector, entries);
  }

  const unused = [];
  const duplicate = [];
  const ownerMissing = [];
  const dynamic = [];
  for (const [selector, entries] of bySelector) {
    const registryEntry = scopedOwnership(selector, entries[0], ownership);
    const isDynamic = entries.some((entry) => entry.dynamicSyntax) || registryEntry?.dynamic === true;
    if (!registryEntry) ownerMissing.push({ ...entries[0], occurrences: entries.length });
    if (isDynamic) {
      dynamic.push({ ...entries[0], owner: registryEntry?.owner ?? null, reason: 'dynamic-or-attribute-selector' });
    } else if (!isStaticallyUsed(selector, evidence)) {
      unused.push({ ...entries[0], owner: registryEntry?.owner ?? null });
    }
  }

  const duplicateRules = new Map();
  for (const occurrence of occurrences) {
    const key = `${occurrence.atRuleContext}\u0000${occurrence.ruleSelector}`;
    const entries = duplicateRules.get(key) ?? [];
    entries.push(occurrence);
    duplicateRules.set(key, entries);
  }
  for (const entries of duplicateRules.values()) {
    const files = [...new Set(entries.map((entry) => entry.file))].sort();
    if (files.length > 1) duplicate.push({
      selector: entries[0].ruleSelector,
      atRuleContext: entries[0].atRuleContext,
      files,
      occurrences: entries.length,
    });
  }

  const sortBySelector = (left, right) => left.selector.localeCompare(right.selector);
  unused.sort(sortBySelector);
  duplicate.sort(sortBySelector);
  ownerMissing.sort(sortBySelector);
  dynamic.sort(sortBySelector);
  return {
    unused: uniqueBySelector(unused),
    duplicate: uniqueBySelector(duplicate),
    ownerMissing: uniqueBySelector(ownerMissing),
    dynamic: uniqueBySelector(dynamic),
  };
}


async function listFiles(directory, predicate) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return listFiles(fullPath, predicate);
    return entry.isFile() && predicate(entry.name) ? [fullPath] : [];
  }));
  return nested.flat().sort();
}


export async function createDeadSelectorReport({ rootDir, frontendDir, ownership }) {
  const [cssFiles, tsxFiles, e2eFiles] = await Promise.all([
    listFiles(path.join(frontendDir, 'src', 'styles'), (name) => name.endsWith('.css')),
    listFiles(path.join(frontendDir, 'src'), (name) => /\.(?:ts|tsx|js|jsx)$/.test(name)),
    listFiles(path.join(frontendDir, 'e2e'), (name) => /\.(?:ts|mjs|js)$/.test(name)),
  ]);
  return scanSelectorUsage({ rootDir, cssFiles, tsxFiles, e2eFiles, ownership });
}


async function runCli() {
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const frontendDir = path.dirname(scriptDir);
  const rootDir = path.dirname(frontendDir);
  const ownership = await loadStyleOwnership(path.join(scriptDir, 'style-ownership.json'));
  const result = await createDeadSelectorReport({ rootDir, frontendDir, ownership });
  const summary = {
    unused: result.unused.length,
    duplicate: result.duplicate.length,
    ownerMissing: result.ownerMissing.length,
    dynamic: result.dynamic.length,
  };
  if (process.argv.includes('--format') && process.argv[process.argv.indexOf('--format') + 1] === 'markdown') {
    process.stdout.write(`# Dead selector report\n\n${Object.entries(summary).map(([name, count]) => `- ${name}: ${count}`).join('\n')}\n`);
  } else {
    process.stdout.write(`${JSON.stringify({ summary, ...result }, null, 2)}\n`);
  }
}


if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await runCli();
}
