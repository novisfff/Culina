import { describe, expect, it } from 'vitest';
import policy from './bundle-budgets.json';
import { evaluateBundlePolicy, measureBundlePolicy } from './bundle-policy.mjs';

const KiB = 1024;
function fixture() {
  const config = structuredClone(policy);
  config.entries = { main: { profile: 'startup', owner: 'platform' }, page: { profile: 'standard', owner: 'page' } };
  const manifest = {
    version: 1, sourceCommit: 'a'.repeat(40), manifestErrors: [],
    entries: {
      main: { initial: { assets: ['main.js', 'shared.js', 'global.css'] }, routeTotal: { assets: ['main.js', 'shared.js', 'global.css', 'page.js', 'optional.js'] } },
      page: { initial: { assets: ['page.js', 'shared.js', 'global.css'] }, routeTotal: { assets: ['page.js', 'shared.js', 'global.css', 'optional.js'] } },
    },
    assets: {
      'main.js': { gzipBytes: 80 * KiB, sourceModules: ['src/main.tsx'] },
      'shared.js': { gzipBytes: 40 * KiB, sourceModules: ['node_modules/shared'] },
      'global.css': { gzipBytes: 50 * KiB, sourceModules: [] },
      'page.js': { gzipBytes: 30 * KiB, sourceModules: ['src/page.tsx'] },
      'optional.js': { gzipBytes: 10 * KiB, sourceModules: ['src/dialog.tsx'] },
    },
  };
  return { config, manifest };
}
function compare(edit = () => {}, options = {}) {
  const { config, manifest } = fixture();
  const current = structuredClone(manifest);
  edit(current, config);
  return evaluateBundlePolicy({ manifest: current, baseManifest: manifest, policy: config, requireBase: true, ...options });
}

describe('v2 bundle performance policy', () => {
  it('counts startup dependencies and CSS, deducts only startup from a page, and deduplicates total', () => {
    const { config, manifest } = fixture();
    const values = measureBundlePolicy(manifest, config);
    expect(values.main).toMatchObject({ js: 120 * KiB, css: 50 * KiB });
    expect(values.page.js).toBe(40 * KiB);
    expect(values['all-assets'].js).toBe(160 * KiB);
  });
  it('does not deduct dependencies merely because another lazy entry shares them', () => {
    const { config, manifest } = fixture();
    manifest.entries.page.shared = ['optional.js'];
    expect(measureBundlePolicy(manifest, config).page.js).toBe(40 * KiB);
  });
  it('allows ordinary page growth without charging it to startup', () => {
    const result = compare((m) => { m.assets['page.js'].gzipBytes += 8 * KiB; });
    expect(result.exitCode).toBe(0);
    expect(result.rows.find((r) => r.entry === 'main' && r.metric === 'js').delta).toBe(0);
  });
  it('warns about a moderate increment but blocks a large new dependency', () => {
    expect(compare((m) => { m.assets['page.js'].gzipBytes += 12 * KiB; }).warnings).toContainEqual(expect.objectContaining({ entry: 'page', reason: 'PR growth warning' }));
    expect(compare((m) => { m.assets['page.js'].gzipBytes += 41 * KiB; }).violations).toContainEqual(expect.objectContaining({ entry: 'page', status: 'fail', reason: expect.stringContaining('PR growth exceeded') }));
  });
  it('uses the larger of absolute and percentage allowances, accepting the exact boundary', () => {
    const { config, manifest } = fixture();
    config.entries.page.profile = 'rich';
    manifest.assets['page.js'].gzipBytes = 100 * KiB;
    const current = structuredClone(manifest);
    current.assets['page.js'].gzipBytes += 40 * KiB;
    expect(evaluateBundlePolicy({ manifest: current, baseManifest: manifest, policy: config }).exitCode).toBe(0);
    current.assets['page.js'].gzipBytes += 1;
    expect(evaluateBundlePolicy({ manifest: current, baseManifest: manifest, policy: config }).exitCode).toBe(1);
  });
  it('keeps absolute limits effective even when the base is already oversized', () => {
    const { config, manifest } = fixture();
    manifest.assets['page.js'].gzipBytes = 100 * KiB;
    expect(evaluateBundlePolicy({ manifest, baseManifest: manifest, policy: config }).violations).toContainEqual(expect.objectContaining({ entry: 'page', reason: 'absolute budget exceeded' }));
  });
  it('blocks CSS growth independently of JS', () => {
    expect(compare((m) => { m.assets['global.css'].gzipBytes += 11 * KiB; }).violations).toContainEqual(expect.objectContaining({ entry: 'main', metric: 'css' }));
  });
  it('reports new configured entries without comparing to a fabricated zero baseline', () => {
    const result = compare((m, p) => { p.entries.new = { profile: 'small', owner: 'new' }; m.entries.new = structuredClone(m.entries.page); m.entries.new.routeTotal.assets = ['optional.js']; });
    expect(result.exitCode).toBe(0);
    expect(result.rows.find((r) => r.entry === 'new').baseline).toBeNull();
  });
  it('fails closed for missing policy entries and configured-but-missing entries', () => {
    expect(compare((m) => { m.entries.extra = m.entries.page; }).exitCode).toBe(1);
    expect(compare((m) => { delete m.entries.page; }).exitCode).toBe(1);
  });
  it('rejects missing comparison evidence, corrupt manifests and incorrect base commit', () => {
    const { config, manifest } = fixture();
    expect(() => evaluateBundlePolicy({ manifest, policy: config, requireBase: true })).toThrow(/required/);
    expect(() => compare(() => {}, { expectedBaseCommit: 'b'.repeat(40) })).toThrow(/mismatch/);
    expect(() => compare((m) => { delete m.assets['shared.js']; })).toThrow(/unresolved/);
    expect(() => compare((m) => { m.manifestErrors.push({ type: 'orphan-chunk' }); })).toThrow(/invalid/);
  });
  it('makes absolute-only local checks explicit and rejects invalid limits', () => {
    const { config, manifest } = fixture();
    expect(evaluateBundlePolicy({ manifest, policy: config }).summary).toContain('absolute budgets only');
    config.profiles.standard.js.fail = 1;
    expect(() => evaluateBundlePolicy({ manifest, policy: config })).toThrow(/warning must precede/);
  });
});
