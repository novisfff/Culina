import { describe, expect, it } from 'vitest';
import { createRouteTransferReport } from './route-transfer-report.mjs';

const manifest = {
  version: 1,
  sourceCommit: '0123456789abcdef0123456789abcdef01234567',
  manifestErrors: [],
  assets: {
    'main.js': { fileName: 'main.js', type: 'js', rawBytes: 100, gzipBytes: 50, sha256: 'a'.repeat(64) },
    'shared.css': { fileName: 'shared.css', type: 'css', rawBytes: 80, gzipBytes: 40, sha256: 'b'.repeat(64) },
  },
  entries: {
    main: {
      source: 'src/main.tsx',
      initial: { assets: ['main.js', 'shared.css'], rawBytes: 180, gzipBytes: 90 },
      routeTotal: { assets: ['main.js', 'shared.css'], rawBytes: 180, gzipBytes: 90 },
      entryCritical: { assets: ['main.js'], rawBytes: 100, gzipBytes: 50 },
      shared: ['shared.css'],
    },
  },
  shared: [{ asset: 'shared.css', entries: ['main'] }],
};

describe('route transfer report', () => {
  it('preserves per-entry transfer metrics and asset hashes', () => {
    const report = createRouteTransferReport(manifest);
    expect(report.version).toBe(1);
    expect(report.sourceCommit).toBe(manifest.sourceCommit);
    expect(report.entries[0]).toMatchObject({ id: 'main', routeTotal: manifest.entries.main.routeTotal, sharedAssets: ['shared.css'] });
    expect(report.assets[1]).toMatchObject({ fileName: 'shared.css', gzipBytes: 40, sha256: 'b'.repeat(64) });
    expect(report.generatedAt).toEqual(expect.any(String));
  });

  it('sorts entries and assets deterministically', () => {
    const report = createRouteTransferReport({ ...manifest, entries: { z: manifest.entries.main, a: manifest.entries.main } });
    expect(report.entries.map((entry) => entry.id)).toEqual(['a', 'z']);
    expect(report.assets.map((asset) => asset.fileName)).toEqual(['main.js', 'shared.css']);
  });

  it('rejects invalid manifests and manifest errors', () => {
    expect(() => createRouteTransferReport(null)).toThrow(/invalid/);
    expect(() => createRouteTransferReport({ ...manifest, manifestErrors: [{ type: 'orphan-chunk' }] })).toThrow(/errors/);
  });

  it('keeps the report free of build-time object references', () => {
    const report = createRouteTransferReport(manifest);
    report.entries[0].initial.assets.push('mutated');
    expect(manifest.entries.main.initial.assets).not.toContain('mutated');
  });
});
