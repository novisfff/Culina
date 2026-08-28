import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export function createRouteTransferReport(manifest) {
  if (!manifest || manifest.version !== 1 || !manifest.entries || !manifest.assets) {
    throw new Error('frontend health manifest is invalid');
  }
  if ((manifest.manifestErrors ?? []).length > 0) {
    throw new Error('cannot create transfer report from a manifest with errors');
  }
  const entries = Object.entries(manifest.entries).sort(([a], [b]) => a.localeCompare(b)).map(([id, entry]) => ({
    id,
    source: entry.source,
    initial: { ...entry.initial, assets: [...entry.initial.assets] },
    routeTotal: { ...entry.routeTotal, assets: [...entry.routeTotal.assets] },
    entryCritical: { ...entry.entryCritical, assets: [...entry.entryCritical.assets] },
    sharedAssets: [...(entry.shared ?? [])],
  }));
  const assets = Object.values(manifest.assets).map((asset) => ({
    fileName: asset.fileName,
    type: asset.type,
    rawBytes: asset.rawBytes,
    gzipBytes: asset.gzipBytes,
    sha256: asset.sha256,
  })).sort((a, b) => a.fileName.localeCompare(b.fileName));
  return {
    version: 1,
    sourceCommit: manifest.sourceCommit,
    generatedAt: new Date().toISOString(),
    entries,
    assets,
    shared: manifest.shared ?? [],
  };
}

function main(argv) {
  const manifestPath = argv[0];
  if (!manifestPath || !existsSync(manifestPath)) throw new Error(`manifest not found: ${manifestPath ?? ''}`);
  const report = createRouteTransferReport(JSON.parse(readFileSync(manifestPath, 'utf8')));
  const outputPath = argv[1] ?? path.join(path.dirname(manifestPath), 'route-transfer-report.json');
  writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  process.stdout.write(`${outputPath}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { main(process.argv.slice(2)); } catch (error) {
    process.stderr.write(`${error.stack ?? error.message}\n`);
    process.exitCode = 1;
  }
}
