import { execFileSync } from 'node:child_process';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import ts from 'typescript';


const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const FRONTEND_ROOT = path.resolve(SCRIPT_DIR, '..');
const DEFAULT_SOURCE_DIR = path.join(FRONTEND_ROOT, 'src');
const DEFAULT_EXCEPTIONS_PATH = path.join(SCRIPT_DIR, 'frontend-health-exceptions.json');
const SHA_PATTERN = /^[a-f0-9]{40}$/i;
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx']);
const CSS_EXTENSION = '.css';


export class FrontendHealthSchemaError extends Error {
  constructor(errors) {
    super(`Invalid frontend health report:\n${errors.join('\n')}`);
    this.name = 'FrontendHealthSchemaError';
    this.errors = errors;
  }
}


function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}


function toPosixPath(value) {
  return value.split(path.sep).join('/');
}


function relativePath(rootDir, file) {
  return toPosixPath(path.relative(rootDir, file));
}


function countLines(content) {
  if (!content) return 0;
  return content.split('\n').length - (content.endsWith('\n') ? 1 : 0);
}


function lineStartsFor(content) {
  const starts = [0];
  for (let index = 0; index < content.length; index += 1) {
    if (content[index] === '\n') starts.push(index + 1);
  }
  return starts;
}


function lineAndColumn(lineStarts, offset) {
  let low = 0;
  let high = lineStarts.length - 1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    if (lineStarts[middle] <= offset) low = middle + 1;
    else high = middle - 1;
  }
  return { line: high + 1, column: offset - lineStarts[high] + 1 };
}


async function listFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries
    .filter((entry) => !entry.name.startsWith('.'))
    .map(async (entry) => {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) return listFiles(fullPath);
      return entry.isFile() ? [fullPath] : [];
    }));
  return nested.flat().sort(compareText);
}


export async function listSourceFiles(sourceDir) {
  const files = await listFiles(sourceDir);
  return files.filter((file) => SOURCE_EXTENSIONS.has(path.extname(file)) || path.extname(file) === CSS_EXTENSION);
}


function gitRevision(rootDir) {
  return execFileSync('git', ['-C', rootDir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
}


function assertCommit(rootDir, commit) {
  if (!SHA_PATTERN.test(commit)) {
    throw new Error(`commit must be a 40-character SHA: ${commit}`);
  }
  return commit.toLowerCase();
}


function visitSource(node, sourceFile, file, state) {
  if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
    state.edges.push({
      from: file,
      to: node.moduleSpecifier.text,
      kind: 'static',
      line: sourceFile.getLineAndCharacterOfPosition(node.moduleSpecifier.getStart(sourceFile)).line + 1,
    });
  }
  if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
    state.edges.push({
      from: file,
      to: node.moduleSpecifier.text,
      kind: 'static',
      line: sourceFile.getLineAndCharacterOfPosition(node.moduleSpecifier.getStart(sourceFile)).line + 1,
    });
  }
  if (
    ts.isCallExpression(node)
    && node.expression.kind === ts.SyntaxKind.ImportKeyword
    && node.arguments.length === 1
    && ts.isStringLiteral(node.arguments[0])
  ) {
    state.edges.push({
      from: file,
      to: node.arguments[0].text,
      kind: 'dynamic',
      line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1,
    });
  }

  if (
    ts.isFunctionDeclaration(node)
    || ts.isFunctionExpression(node)
    || ts.isArrowFunction(node)
    || ts.isMethodDeclaration(node)
  ) {
    state.functions += 1;
  }
  if (
    ts.isIfStatement(node)
    || ts.isConditionalExpression(node)
    || ts.isSwitchStatement(node)
    || ts.isCaseClause(node)
    || ts.isForStatement(node)
    || ts.isForInStatement(node)
    || ts.isForOfStatement(node)
    || ts.isWhileStatement(node)
    || ts.isDoStatement(node)
  ) {
    state.conditions += 1;
  }
  if (ts.isJsxAttribute(node) && /^on[A-Z]/.test(node.name.text)) {
    state.jsxHandlers += 1;
  }
  ts.forEachChild(node, (child) => visitSource(child, sourceFile, file, state));
}


function scanSourceFile(content, file) {
  const scriptKind = file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sourceFile = ts.createSourceFile(file, content, ts.ScriptTarget.Latest, true, scriptKind);
  const state = { edges: [], functions: 0, conditions: 0, jsxHandlers: 0 };
  visitSource(sourceFile, sourceFile, file, state);
  return {
    edges: state.edges,
    parseErrors: sourceFile.parseDiagnostics.map((diagnostic) => ({
      file,
      line: sourceFile.getLineAndCharacterOfPosition(diagnostic.start ?? 0).line + 1,
      message: ts.flattenDiagnosticMessageText(diagnostic.messageText, ' '),
    })),
    hotspot: {
      file,
      functions: state.functions,
      conditions: state.conditions,
      jsxHandlers: state.jsxHandlers,
      score: state.functions + state.conditions + state.jsxHandlers,
    },
  };
}


function skipCssComment(content, index, end) {
  if (content[index] !== '/' || content[index + 1] !== '*') return index;
  const closing = content.indexOf('*/', index + 2);
  return closing === -1 || closing >= end ? end : closing + 2;
}


function skipCssString(content, index, end) {
  const quote = content[index];
  if (quote !== '"' && quote !== "'") return index;
  let cursor = index + 1;
  while (cursor < end) {
    if (content[cursor] === '\\') {
      cursor += 2;
      continue;
    }
    if (content[cursor] === quote) return cursor + 1;
    cursor += 1;
  }
  return end;
}


function skipCssWhitespaceAndComments(content, index, end) {
  let cursor = index;
  while (cursor < end) {
    if (/\s/.test(content[cursor])) {
      cursor += 1;
      continue;
    }
    const afterComment = skipCssComment(content, cursor, end);
    if (afterComment !== cursor) {
      cursor = afterComment;
      continue;
    }
    break;
  }
  return cursor;
}


function findCssDelimiter(content, start, end, delimiters) {
  let parentheses = 0;
  let brackets = 0;
  let cursor = start;
  while (cursor < end) {
    const afterComment = skipCssComment(content, cursor, end);
    if (afterComment !== cursor) {
      cursor = afterComment;
      continue;
    }
    const afterString = skipCssString(content, cursor, end);
    if (afterString !== cursor) {
      cursor = afterString;
      continue;
    }
    const character = content[cursor];
    if (character === '(') parentheses += 1;
    else if (character === ')') parentheses = Math.max(0, parentheses - 1);
    else if (character === '[') brackets += 1;
    else if (character === ']') brackets = Math.max(0, brackets - 1);
    else if (parentheses === 0 && brackets === 0 && delimiters.has(character)) {
      return { character, index: cursor };
    }
    cursor += 1;
  }
  return { character: null, index: end };
}


function findMatchingCssBrace(content, openIndex, end) {
  let depth = 1;
  let cursor = openIndex + 1;
  while (cursor < end) {
    const afterComment = skipCssComment(content, cursor, end);
    if (afterComment !== cursor) {
      cursor = afterComment;
      continue;
    }
    const afterString = skipCssString(content, cursor, end);
    if (afterString !== cursor) {
      cursor = afterString;
      continue;
    }
    if (content[cursor] === '{') depth += 1;
    if (content[cursor] === '}') {
      depth -= 1;
      if (depth === 0) return cursor;
    }
    cursor += 1;
  }
  return end;
}


function normalizeCssPrelude(value) {
  return value.replace(/\s+/g, ' ').trim();
}


function firstCssColon(content, start, end) {
  return findCssDelimiter(content, start, end, new Set([':'])).index;
}


function scanValueTokens(content, start, end, callback) {
  let cursor = start;
  while (cursor < end) {
    const afterComment = skipCssComment(content, cursor, end);
    if (afterComment !== cursor) {
      cursor = afterComment;
      continue;
    }
    const afterString = skipCssString(content, cursor, end);
    if (afterString !== cursor) {
      cursor = afterString;
      continue;
    }
    callback(cursor);
    cursor += 1;
  }
}


function findVarEnd(content, openIndex, end) {
  let depth = 1;
  let cursor = openIndex + 1;
  while (cursor < end) {
    const afterComment = skipCssComment(content, cursor, end);
    if (afterComment !== cursor) {
      cursor = afterComment;
      continue;
    }
    const afterString = skipCssString(content, cursor, end);
    if (afterString !== cursor) {
      cursor = afterString;
      continue;
    }
    if (content[cursor] === '(') depth += 1;
    if (content[cursor] === ')') {
      depth -= 1;
      if (depth === 0) return cursor;
    }
    cursor += 1;
  }
  return end;
}


function splitVarArguments(content, start, end) {
  let parentheses = 0;
  let cursor = start;
  while (cursor < end) {
    const afterComment = skipCssComment(content, cursor, end);
    if (afterComment !== cursor) {
      cursor = afterComment;
      continue;
    }
    const afterString = skipCssString(content, cursor, end);
    if (afterString !== cursor) {
      cursor = afterString;
      continue;
    }
    if (content[cursor] === '(') parentheses += 1;
    else if (content[cursor] === ')') parentheses = Math.max(0, parentheses - 1);
    else if (content[cursor] === ',' && parentheses === 0) return cursor;
    cursor += 1;
  }
  return -1;
}


function isIdentifierBoundary(character) {
  return !character || !/[a-zA-Z0-9_-]/.test(character);
}


function addCssHit(state, file, metric, value, offset) {
  const position = lineAndColumn(state.lineStarts, offset);
  state.hits.push({ file, line: position.line, column: position.column, metric, value });
}


function scanDeclarationValue(content, start, end, state, file) {
  scanValueTokens(content, start, end, (cursor) => {
    if (
      content.startsWith('!important', cursor)
      && isIdentifierBoundary(content[cursor - 1])
      && isIdentifierBoundary(content[cursor + '!important'.length])
    ) {
      state.important += 1;
      addCssHit(state, file, 'important', '!important', cursor);
    }

    if (
      content.startsWith('var', cursor)
      && isIdentifierBoundary(content[cursor - 1])
      && /\s*\(/.test(content.slice(cursor + 3, Math.min(end, cursor + 12)))
    ) {
      let open = cursor + 3;
      while (open < end && /\s/.test(content[open])) open += 1;
      if (content[open] !== '(') return;
      const close = findVarEnd(content, open, end);
      const separator = splitVarArguments(content, open + 1, close);
      const nameEnd = separator === -1 ? close : separator;
      const name = content.slice(open + 1, nameEnd).trim();
      if (!name.startsWith('--')) return;
      const fallback = separator === -1 ? '' : content.slice(separator + 1, close).trim();
      const nameOffset = content.indexOf(name, open + 1);
      const position = lineAndColumn(state.lineStarts, nameOffset);
      state.variableReferences.push({
        file,
        name,
        fallback,
        offset: nameOffset,
        line: position.line,
        column: position.column,
      });
      addCssHit(state, file, 'variable', name, nameOffset);
    }
  });
}


function parseCssDeclarations(content, start, end, state, file) {
  let cursor = start;
  while (cursor < end) {
    cursor = skipCssWhitespaceAndComments(content, cursor, end);
    if (cursor >= end) break;
    const delimiter = findCssDelimiter(content, cursor, end, new Set([';', '{', '}']));
    if (delimiter.character === '{') {
      const prelude = normalizeCssPrelude(content.slice(cursor, delimiter.index));
      const close = findMatchingCssBrace(content, delimiter.index, end);
      if (/^@media\b/i.test(prelude)) {
        state.media += 1;
        addCssHit(state, file, 'media', prelude, cursor);
        parseCssRules(content, delimiter.index + 1, close, state, file);
      } else if (!/^@(?:keyframes|font-face|property)\b/i.test(prelude)) {
        state.selectorBlocks += 1;
        addCssHit(state, file, 'selector', prelude, cursor);
        parseCssDeclarations(content, delimiter.index + 1, close, state, file);
      }
      cursor = close + 1;
      continue;
    }
    const declarationEnd = delimiter.index;
    const colon = firstCssColon(content, cursor, declarationEnd);
    if (colon < declarationEnd) {
      const name = content.slice(cursor, colon).trim();
      if (name && !name.startsWith('@')) {
        state.declarations += 1;
        const nameOffset = content.indexOf(name, cursor);
        addCssHit(state, file, 'declaration', name, nameOffset);
        if (name.startsWith('--')) state.definedVariables.add(name);
        scanDeclarationValue(content, colon + 1, declarationEnd, state, file);
      }
    }
    if (!delimiter.character || delimiter.character === '}') break;
    cursor = delimiter.index + 1;
  }
}


function parseCssRules(content, start, end, state, file) {
  let cursor = start;
  while (cursor < end) {
    cursor = skipCssWhitespaceAndComments(content, cursor, end);
    if (cursor >= end) break;
    const delimiter = findCssDelimiter(content, cursor, end, new Set(['{', '}', ';']));
    if (delimiter.character === '}') return;
    if (delimiter.character !== '{') {
      cursor = delimiter.index + 1;
      continue;
    }
    const prelude = normalizeCssPrelude(content.slice(cursor, delimiter.index));
    const close = findMatchingCssBrace(content, delimiter.index, end);
    if (/^@media\b/i.test(prelude)) {
      state.media += 1;
      addCssHit(state, file, 'media', prelude, cursor);
      parseCssRules(content, delimiter.index + 1, close, state, file);
    } else if (/^@keyframes\b/i.test(prelude)) {
      // Keyframe percentages are not selectors or declarations for governance metrics.
    } else if (/^@(?:font-face|property)\b/i.test(prelude)) {
      parseCssDeclarations(content, delimiter.index + 1, close, state, file);
    } else if (/^@/i.test(prelude)) {
      parseCssRules(content, delimiter.index + 1, close, state, file);
    } else if (prelude) {
      state.selectorBlocks += 1;
      addCssHit(state, file, 'selector', prelude, cursor);
      parseCssDeclarations(content, delimiter.index + 1, close, state, file);
    }
    cursor = close + 1;
  }
}


function validateExceptions(exceptions, now) {
  if (!exceptions || typeof exceptions !== 'object' || Array.isArray(exceptions)) {
    throw new Error('frontend health exceptions must be an object');
  }
  if (exceptions.version !== 1 || !Array.isArray(exceptions.exceptions)) {
    throw new Error('frontend health exceptions must contain version 1 and an exceptions array');
  }
  const required = ['metric', 'file', 'owner', 'reason', 'introducedAt', 'expiresAt', 'replacement', 'test'];
  for (const [index, exception] of exceptions.exceptions.entries()) {
    for (const field of required) {
      if (typeof exception[field] !== 'string' || !exception[field].trim()) {
        throw new Error(`incomplete exception ${index}: ${field}`);
      }
    }
    if (exception.expiresAt < now) {
      throw new Error(`expired exception ${index}: ${exception.metric} ${exception.file}`);
    }
    if (exception.metric === 'runtime-variable') {
      for (const field of ['variable', 'source', 'fallback']) {
        if (typeof exception[field] !== 'string' || !exception[field].trim()) {
          throw new Error(`incomplete runtime exception ${index}: ${field}`);
        }
      }
      if (!Array.isArray(exception.consumers) || exception.consumers.length === 0) {
        throw new Error(`incomplete runtime exception ${index}: consumers`);
      }
    }
  }
  return exceptions;
}


async function readExceptions(exceptionsPath) {
  return JSON.parse(await readFile(exceptionsPath, 'utf8'));
}


function classifyVariables(variableReferences, definedVariables, exceptions) {
  const runtimeVariables = new Set(exceptions.exceptions
    .filter((exception) => exception.metric === 'runtime-variable')
    .map((exception) => exception.variable));
  return variableReferences.map((reference) => ({
    ...reference,
    classification: reference.fallback
      ? 'fallback-safe'
      : definedVariables.has(reference.name)
        ? 'defined'
        : runtimeVariables.has(reference.name)
          ? 'runtime-allowed'
          : 'undefined',
  }));
}


export async function collectFrontendHealth({
  rootDir = FRONTEND_ROOT,
  sourceDir = DEFAULT_SOURCE_DIR,
  commit,
  exceptions,
  exceptionsPath = DEFAULT_EXCEPTIONS_PATH,
  now = new Date().toISOString().slice(0, 10),
} = {}) {
  const sourceCommit = commit ? assertCommit(rootDir, commit) : gitRevision(rootDir);
  const configuredExceptions = validateExceptions(
    exceptions ?? await readExceptions(exceptionsPath),
    now,
  );
  const files = await listSourceFiles(sourceDir);
  const sourceFiles = files.filter((file) => SOURCE_EXTENSIONS.has(path.extname(file)));
  const cssFiles = files.filter((file) => path.extname(file) === CSS_EXTENSION);
  const sourcePaths = sourceFiles.map((file) => relativePath(rootDir, file)).sort(compareText);
  const cssPaths = cssFiles.map((file) => relativePath(rootDir, file)).sort(compareText);
  const byExtension = { '.ts': 0, '.tsx': 0 };
  const sourceState = { edges: [], parseErrors: [], hotspots: [], lines: 0 };

  for (const file of sourceFiles) {
    const content = await readFile(file, 'utf8');
    const relative = relativePath(rootDir, file);
    const scan = scanSourceFile(content, relative);
    byExtension[path.extname(file)] += 1;
    sourceState.lines += countLines(content);
    sourceState.edges.push(...scan.edges);
    sourceState.parseErrors.push(...scan.parseErrors);
    sourceState.hotspots.push(scan.hotspot);
  }

  sourceState.edges.sort((left, right) => (
    compareText(left.from, right.from)
    || left.line - right.line
    || compareText(left.kind, right.kind)
    || compareText(left.to, right.to)
  ));
  sourceState.parseErrors.sort((left, right) => compareText(left.file, right.file) || left.line - right.line);
  sourceState.hotspots.sort((left, right) => (
    right.score - left.score || compareText(left.file, right.file)
  ));

  const cssState = {
    declarations: 0,
    definedVariables: new Set(),
    hits: [],
    important: 0,
    lineStarts: [],
    media: 0,
    selectorBlocks: 0,
    variableReferences: [],
    lines: 0,
  };
  for (const file of cssFiles) {
    const content = await readFile(file, 'utf8');
    const relative = relativePath(rootDir, file);
    cssState.lineStarts = lineStartsFor(content);
    cssState.lines += countLines(content);
    parseCssRules(content, 0, content.length, cssState, relative);
  }
  const variables = classifyVariables(
    cssState.variableReferences,
    cssState.definedVariables,
    configuredExceptions,
  ).map(({ offset, fallback, ...variable }) => variable);
  variables.sort((left, right) => (
    compareText(left.file, right.file)
    || left.line - right.line
    || left.column - right.column
    || compareText(left.name, right.name)
  ));
  cssState.hits.sort((left, right) => (
    compareText(left.file, right.file)
    || left.line - right.line
    || left.column - right.column
    || compareText(left.metric, right.metric)
    || compareText(left.value, right.value)
  ));

  const staticEdges = sourceState.edges.filter((edge) => edge.kind === 'static');
  const dynamicEdges = sourceState.edges.filter((edge) => edge.kind === 'dynamic');
  const report = {
    version: 1,
    toolchain: {
      node: process.version,
      typescript: ts.version,
    },
    source: {
      ref: { commit: sourceCommit, source: commit ? 'explicit' : 'git' },
      files: sourceFiles.length,
      lines: sourceState.lines,
      byExtension,
      paths: sourcePaths,
      parseErrors: sourceState.parseErrors,
      hotspots: sourceState.hotspots,
    },
    css: {
      files: cssFiles.length,
      lines: cssState.lines,
      paths: cssPaths,
      selectorBlocks: cssState.selectorBlocks,
      declarations: cssState.declarations,
      important: cssState.important,
      media: cssState.media,
      definedVariables: [...cssState.definedVariables].sort(compareText),
      variables,
      undefinedVariables: [...new Set(variables
        .filter((variable) => variable.classification === 'undefined')
        .map((variable) => variable.name))].sort(compareText),
      hits: cssState.hits,
    },
    tests: {
      files: sourcePaths.filter((file) => /\.test\.(?:ts|tsx)$/.test(file)).length,
    },
    dependencies: {
      staticEdges: staticEdges.length,
      dynamicEdges: dynamicEdges.length,
      edges: sourceState.edges,
    },
    exceptions: {
      total: configuredExceptions.exceptions.length,
      expired: 0,
    },
  };
  const validated = validateFrontendHealth(report);
  if (!validated.valid) throw new FrontendHealthSchemaError(validated.errors);
  return report;
}


export function validateFrontendHealth(report) {
  const errors = [];
  if (!report || typeof report !== 'object' || Array.isArray(report)) {
    return { valid: false, errors: ['$ must be an object'] };
  }
  if (report.version !== 1) errors.push('$.version must equal 1');
  for (const field of ['toolchain', 'source', 'css', 'tests', 'dependencies', 'exceptions']) {
    if (!report[field] || typeof report[field] !== 'object' || Array.isArray(report[field])) {
      errors.push(`$.${field} must be an object`);
    }
  }
  if (!Number.isInteger(report.source?.files) || report.source.files < 0) {
    errors.push('$.source.files must be a non-negative integer');
  }
  if (!Array.isArray(report.dependencies?.edges)) {
    errors.push('$.dependencies.edges must be an array');
  }
  if (!Array.isArray(report.css?.hits) || !Array.isArray(report.css?.variables)) {
    errors.push('$.css.hits and $.css.variables must be arrays');
  }
  return errors.length === 0 ? { valid: true } : { valid: false, errors: errors.sort(compareText) };
}


export function formatHealthMarkdown(report) {
  const source = report.source;
  const css = report.css;
  const dependencies = report.dependencies;
  return [
    '# Frontend health report',
    '',
    '| Source | Value |',
    '| --- | ---: |',
    `| Commit | ${source.ref.commit} |`,
    `| TS/TSX files | ${source.files} |`,
    `| TS/TSX lines | ${source.lines} |`,
    `| CSS files | ${css.files} |`,
    `| CSS lines | ${css.lines} |`,
    '',
    '| CSS | Value |',
    '| --- | ---: |',
    `| Selector blocks | ${css.selectorBlocks} |`,
    `| Declarations | ${css.declarations} |`,
    `| !important | ${css.important} |`,
    `| @media | ${css.media} |`,
    `| Undefined variables | ${css.undefinedVariables.length} |`,
    '',
    '| Dependencies | Value |',
    '| --- | ---: |',
    `| Static edges | ${dependencies.staticEdges} |`,
    `| Dynamic edges | ${dependencies.dynamicEdges} |`,
    `| Parse errors | ${source.parseErrors.length} |`,
    '',
    '| Exceptions | Value |',
    '| --- | ---: |',
    `| Total | ${report.exceptions.total} |`,
    `| Expired | ${report.exceptions.expired} |`,
    '',
  ].join('\n');
}


function parseCommandLine(argv) {
  const options = { format: 'json' };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--format') options.format = argv[++index];
    else if (argument === '--output') options.output = argv[++index];
    else if (argument === '--commit') options.commit = argv[++index];
    else if (argument === '--check-baseline') options.checkBaseline = argv[++index];
    else throw new Error(`unknown argument: ${argument}`);
  }
  if (!['json', 'markdown'].includes(options.format)) {
    throw new Error(`unsupported format: ${options.format}`);
  }
  return options;
}


async function runCli() {
  const options = parseCommandLine(process.argv.slice(2));
  if (options.checkBaseline) {
    const { readHealthBaseline } = await import('./frontend-health-baseline.mjs');
    const baseline = await readHealthBaseline(path.resolve(process.cwd(), options.checkBaseline));
    process.stdout.write(`${baseline.sourceCommit}\n`);
    return;
  }
  const report = await collectFrontendHealth({ commit: options.commit });
  const output = options.format === 'markdown'
    ? formatHealthMarkdown(report)
    : `${JSON.stringify(report, null, 2)}\n`;
  if (options.output) await writeFile(path.resolve(process.cwd(), options.output), output, 'utf8');
  else process.stdout.write(output);
}


if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli().catch((error) => {
    process.stderr.write(`${error.stack ?? error.message}\n`);
    process.exitCode = 1;
  });
}
