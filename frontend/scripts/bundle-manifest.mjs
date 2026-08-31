import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';


const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const FRONTEND_ROOT = path.resolve(SCRIPT_DIR, '..');
const SHA_PATTERN = /^[a-f0-9]{40}$/i;


function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}


function toPosixPath(value) {
  return value.split(path.sep).join('/');
}


function normalizeSource(source, rootDir) {
  if (!source) return null;
  const normalizedRoot = toPosixPath(path.resolve(rootDir));
  const normalizedSource = toPosixPath(source);
  if (normalizedSource === normalizedRoot) return '.';
  if (normalizedSource.startsWith(`${normalizedRoot}/`)) {
    return normalizedSource.slice(normalizedRoot.length + 1);
  }
  return normalizedSource;
}


function sourceBuffer(value) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  return Buffer.from(String(value ?? ''), 'utf8');
}


function assetSummary(fileName, content, type, sourceModules = []) {
  const bytes = sourceBuffer(content);
  return {
    fileName,
    type,
    rawBytes: bytes.byteLength,
    gzipBytes: gzipSync(bytes, { level: 9, mtime: 0 }).byteLength,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    sourceModules: [...new Set(sourceModules)].sort(compareText),
  };
}


function normalizeEntryConfig(entryConfig) {
  if (!entryConfig || typeof entryConfig !== 'object' || Array.isArray(entryConfig)) {
    throw new Error('bundle entrypoints config must be an object');
  }
  if (entryConfig.version !== 1 || !entryConfig.entries || typeof entryConfig.entries !== 'object') {
    throw new Error('bundle entrypoints config must contain version 1 and entries');
  }
  const entries = {};
  for (const [id, value] of Object.entries(entryConfig.entries)) {
    const entry = typeof value === 'string' ? { source: value, dynamic: false } : value;
    if (!id || !entry || typeof entry !== 'object' || typeof entry.source !== 'string' || !entry.source.startsWith('src/')) {
      throw new Error(`invalid bundle entrypoint: ${id}`);
    }
    const styleSources = Array.isArray(entry.styleSources)
      ? entry.styleSources.filter((source) => typeof source === 'string' && source.startsWith('src/'))
      : [];
    const additionalSources = Array.isArray(entry.additionalSources)
      ? entry.additionalSources.filter((source) => typeof source === 'string' && source.startsWith('src/'))
      : [];
    entries[id] = { source: entry.source, dynamic: Boolean(entry.dynamic), styleSources, additionalSources };
  }
  return { version: 1, entries };
}


export function resolveLogicalEntry(source, entryConfig) {
  const config = normalizeEntryConfig(entryConfig);
  const matching = Object.entries(config.entries)
    .filter(([, entry]) => entry.source === source || entry.styleSources.includes(source) || entry.additionalSources.includes(source))
    .map(([id]) => id)
    .sort(compareText);
  if (matching.length > 1) {
    throw new Error(`multiple logical entries use source ${source}: ${matching.join(', ')}`);
  }
  return matching[0] ?? null;
}


function createManifestError(type, details = {}) {
  return { type, ...details };
}


function collectBundleAssets(bundle, rootDir) {
  const assets = {};
  const chunks = new Map();
  for (const [fileName, output] of Object.entries(bundle).sort(([left], [right]) => compareText(left, right))) {
    if (output.type === 'chunk') {
      const sourceModules = (output.moduleIds ?? [])
        .map((moduleId) => normalizeSource(moduleId, rootDir))
        .filter(Boolean)
        .sort(compareText);
      const css = [...(output.viteMetadata?.importedCss ?? [])].sort(compareText);
      const chunk = {
        fileName,
        facadeSource: normalizeSource(output.facadeModuleId, rootDir),
        code: output.code ?? '',
        imports: [...(output.imports ?? [])].sort(compareText),
        dynamicImports: [...(output.dynamicImports ?? [])].sort(compareText),
        css,
        isEntry: Boolean(output.isEntry),
        isDynamicEntry: Boolean(output.isDynamicEntry),
        sourceModules,
      };
      chunks.set(fileName, chunk);
      assets[fileName] = assetSummary(fileName, chunk.code, 'js', sourceModules);
      continue;
    }
    if (output.type === 'asset') {
      const type = fileName.endsWith('.css') ? 'css' : 'asset';
      assets[fileName] = assetSummary(fileName, output.source, type);
    }
  }
  return { assets, chunks };
}


function directAssets(chunk) {
  return [chunk.fileName, ...chunk.css].sort(compareText);
}


function summarizeAssets(assetNames, assets) {
  const existing = [...assetNames].filter((asset) => Boolean(assets[asset])).sort(compareText);
  return {
    assets: existing,
    rawBytes: existing.reduce((total, asset) => total + assets[asset].rawBytes, 0),
    gzipBytes: existing.reduce((total, asset) => total + assets[asset].gzipBytes, 0),
  };
}


function reachableAssets(rootChunk, chunks, assets, includeDynamic) {
  const reachable = new Set();
  const visitedChunks = new Set();
  const visit = (fileName, isRoot = false) => {
    if (visitedChunks.has(fileName)) return;
    visitedChunks.add(fileName);
    const chunk = chunks.get(fileName);
    if (!chunk) return;
    for (const asset of directAssets(chunk)) {
      if (assets[asset]) reachable.add(asset);
    }
    for (const imported of chunk.imports) visit(imported);
    // A route entry can import the shared main chunk. Do not follow the
    // main entry's sibling route imports when calculating this route's
    // transfer; only the route root may fan out into its own dynamic graph.
    if (includeDynamic && (isRoot || !chunk.isEntry)) {
      for (const imported of chunk.dynamicImports) visit(imported);
    }
  };
  visit(rootChunk.fileName, true);
  return reachable;
}

function ownedStyleAssets(entry, chunks) {
  const sources = new Set(entry.styleSources ?? []);
  return [...chunks.values()]
    .filter((chunk) => sources.has(chunk.facadeSource))
    .flatMap((chunk) => [chunk.fileName, ...chunk.css]);
}


function findEntryChunk(source, chunks) {
  const byFacade = [...chunks.values()]
    .filter((chunk) => chunk.facadeSource === source)
    .sort((left, right) => compareText(left.fileName, right.fileName));
  if (byFacade.length > 0) return byFacade;
  return [...chunks.values()]
    .filter((chunk) => chunk.sourceModules.includes(source))
    .sort((left, right) => compareText(left.fileName, right.fileName));
}


function logicalEntryForChunk(chunk, config) {
  if (chunk.facadeSource) {
    const facadeEntry = resolveLogicalEntry(chunk.facadeSource, config);
    if (facadeEntry) return facadeEntry;
  }
  if (chunk.isEntry && chunk.sourceModules.includes(config.entries.main?.source)) {
    return 'main';
  }
  const matches = [...new Set(chunk.sourceModules
    .map((source) => resolveLogicalEntry(source, config))
    .filter(Boolean))];
  return matches.length === 1 ? matches[0] : null;
}


function manifestCommit(rootDir, commit) {
  if (commit) {
    if (!SHA_PATTERN.test(commit)) throw new Error(`manifest commit must be a 40-character SHA: ${commit}`);
    return commit.toLowerCase();
  }
  try {
    return execFileSync('git', ['-C', rootDir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  } catch (error) {
    const sourceCommit = process.env.GITHUB_SHA ?? process.env.SOURCE_COMMIT;
    if (sourceCommit && SHA_PATTERN.test(sourceCommit)) return sourceCommit.toLowerCase();
    if (error?.code === 'ENOENT') return '0000000000000000000000000000000000000000';
    throw error;
  }
}


function sortManifestErrors(errors) {
  return errors.sort((left, right) => (
    compareText(left.type, right.type)
    || compareText(left.entry ?? '', right.entry ?? '')
    || compareText(left.asset ?? '', right.asset ?? '')
    || compareText(left.source ?? '', right.source ?? '')
  ));
}


export function createFrontendHealthManifest({
  bundle,
  entryConfig,
  rootDir = FRONTEND_ROOT,
  commit,
} = {}) {
  const config = normalizeEntryConfig(entryConfig);
  const sourceCommit = manifestCommit(rootDir, commit);
  const { assets, chunks } = collectBundleAssets(bundle, rootDir);
  const manifestErrors = [];

  for (const chunk of chunks.values()) {
    for (const imported of [...chunk.imports, ...chunk.dynamicImports]) {
      if (!chunks.has(imported)) {
        manifestErrors.push(createManifestError('unresolved-import', {
          asset: imported,
          source: chunk.fileName,
        }));
      }
    }
    for (const css of chunk.css) {
      if (!assets[css]) {
        manifestErrors.push(createManifestError('unresolved-css', {
          asset: css,
          source: chunk.fileName,
        }));
      }
    }
  }

  const entries = {};
  for (const [id, entry] of Object.entries(config.entries).sort(([left], [right]) => compareText(left, right))) {
    const candidates = findEntryChunk(entry.source, chunks);
    if (candidates.length === 0) {
      manifestErrors.push(createManifestError('missing-entry', { entry: id, source: entry.source }));
      continue;
    }
    if (candidates.length > 1) {
      manifestErrors.push(createManifestError('ambiguous-entry', {
        entry: id,
        source: entry.source,
        assets: candidates.map((candidate) => candidate.fileName),
      }));
      continue;
    }
    const chunk = candidates[0];
    if (entry.dynamic && !chunk.isDynamicEntry) {
      manifestErrors.push(createManifestError('missing-dynamic-entry', {
        entry: id,
        source: entry.source,
        asset: chunk.fileName,
      }));
    }
    const initialAssets = id === 'main'
      ? [...new Set([...reachableAssets(chunk, chunks, assets, false), ...ownedStyleAssets(entry, chunks)])]
      : reachableAssets(chunk, chunks, assets, false);
    entries[id] = {
      source: entry.source,
      js: [chunk.fileName],
      css: [...chunk.css],
      imports: [...chunk.imports],
      dynamicImports: [...chunk.dynamicImports],
      initial: summarizeAssets(initialAssets, assets),
      entryCritical: summarizeAssets([chunk.fileName], assets),
      routeTotal: summarizeAssets(reachableAssets(chunk, chunks, assets, true), assets),
      shared: [],
    };
  }

  for (const chunk of chunks.values()) {
    if (!chunk.isEntry && !chunk.isDynamicEntry) continue;
    const source = chunk.facadeSource;
    const entryId = logicalEntryForChunk(chunk, config);
    const registeredAsDynamic = entryId && (
      config.entries[entryId].dynamic
      || config.entries[entryId].styleSources.includes(source)
    );
    if (chunk.isDynamicEntry && !registeredAsDynamic) {
      manifestErrors.push(createManifestError('unregistered-dynamic-entry', {
        asset: chunk.fileName,
        source,
      }));
    }
    if (!entryId || (chunk.isDynamicEntry && !registeredAsDynamic)) {
      manifestErrors.push(createManifestError('orphan-chunk', {
        asset: chunk.fileName,
        source,
      }));
    }
  }

  const assetConsumers = new Map();
  for (const [entryId, entry] of Object.entries(entries)) {
    for (const asset of entry.initial.assets) {
      const consumers = assetConsumers.get(asset) ?? [];
      consumers.push(entryId);
      assetConsumers.set(asset, consumers);
    }
  }
  const shared = [...assetConsumers.entries()]
    .filter(([, consumers]) => consumers.length > 1)
    .map(([asset, consumers]) => ({ asset, entries: consumers.sort(compareText) }))
    .sort((left, right) => compareText(left.asset, right.asset));
  for (const [entryId, entry] of Object.entries(entries)) {
    entry.shared = shared
      .filter((item) => item.entries.includes(entryId))
      .map((item) => item.asset)
      .sort(compareText);
    const sharedAssets = new Set(entry.shared);
    const transferAssets = entry.routeTotal.assets.filter((asset) => !sharedAssets.has(asset));
    entry.routeTransfer = summarizeAssets(transferAssets, assets);
  }

  return {
    version: 1,
    sourceCommit,
    entries,
    assets: Object.fromEntries(Object.entries(assets).sort(([left], [right]) => compareText(left, right))),
    shared,
    manifestErrors: sortManifestErrors(manifestErrors),
  };
}


export function assertFrontendHealthManifest(manifest, entryConfig) {
  const config = normalizeEntryConfig(entryConfig);
  const violations = [...(manifest?.manifestErrors ?? [])];
  if (!manifest || manifest.version !== 1) {
    violations.push(createManifestError('invalid-manifest'));
  }
  for (const id of Object.keys(config.entries).sort(compareText)) {
    if (!manifest?.entries?.[id]) {
      violations.push(createManifestError('missing-entry', { entry: id }));
    }
  }
  return { violations: sortManifestErrors(violations), ok: violations.length === 0 };
}


export function viteFrontendHealthManifestPlugin({ entryConfig } = {}) {
  let rootDir = FRONTEND_ROOT;
  return {
    name: 'culina-frontend-health-manifest',
    apply: 'build',
    configResolved(config) {
      rootDir = config.root;
    },
    generateBundle(_outputOptions, bundle) {
      const manifest = createFrontendHealthManifest({ bundle, entryConfig, rootDir });
      this.emitFile({
        type: 'asset',
        fileName: '.vite/frontend-health-manifest.json',
        source: `${JSON.stringify(manifest, null, 2)}\n`,
      });
    },
  };
}


async function runCli() {
  const [flag, manifestPath] = process.argv.slice(2);
  if (flag !== '--check' || !manifestPath) {
    throw new Error('usage: bundle-manifest.mjs --check <manifest-path>');
  }
  const manifest = JSON.parse(await readFile(path.resolve(process.cwd(), manifestPath), 'utf8'));
  const entryConfig = JSON.parse(await readFile(path.join(SCRIPT_DIR, 'bundle-entrypoints.json'), 'utf8'));
  const assertion = assertFrontendHealthManifest(manifest, entryConfig);
  if (!assertion.ok) {
    process.stderr.write(`${JSON.stringify(assertion.violations, null, 2)}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`frontend health manifest: ${Object.keys(manifest.entries).length} entries\n`);
}


if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli().catch((error) => {
    process.stderr.write(`${error.stack ?? error.message}\n`);
    process.exitCode = 1;
  });
}
