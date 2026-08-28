import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';

import { describe, expect, it } from 'vitest';

import {
  assertFrontendHealthManifest,
  createFrontendHealthManifest,
  resolveLogicalEntry,
} from './bundle-manifest.mjs';


const ROOT_DIR = '/repo/frontend';
const COMMIT = '0123456789abcdef0123456789abcdef01234567';

const ENTRY_CONFIG = {
  version: 1,
  entries: {
    main: { source: 'src/main.tsx', dynamic: false },
    ai: { source: 'src/components/ai/AiWorkspace.tsx', dynamic: true },
    markdown: { source: 'src/components/ai/MarkdownMessage.tsx', dynamic: true },
  },
};


function chunk({
  fileName,
  source,
  code,
  imports = [],
  dynamicImports = [],
  css = [],
  isEntry = false,
  isDynamicEntry = false,
  modules = [],
}) {
  return {
    type: 'chunk',
    fileName,
    facadeModuleId: source ? `${ROOT_DIR}/${source}` : null,
    code,
    imports,
    dynamicImports,
    isEntry,
    isDynamicEntry,
    moduleIds: modules.map((module) => `${ROOT_DIR}/${module}`),
    viteMetadata: { importedCss: new Set(css) },
  };
}


function asset(fileName, source) {
  return { type: 'asset', fileName, source };
}


function completeBundle() {
  return {
    'opaque-main.js': chunk({
      fileName: 'opaque-main.js',
      source: 'index.html',
      code: 'main();',
      imports: ['shared.js'],
      dynamicImports: ['opaque-ai.js'],
      css: ['main.css'],
      isEntry: true,
      modules: ['src/main.tsx'],
    }),
    'opaque-ai.js': chunk({
      fileName: 'opaque-ai.js',
      source: 'src/components/ai/AiWorkspace.tsx',
      code: 'ai();',
      imports: ['shared.js'],
      dynamicImports: ['opaque-markdown.js'],
      css: ['ai.css'],
      isDynamicEntry: true,
      modules: ['src/components/ai/AiWorkspace.tsx'],
    }),
    'opaque-markdown.js': chunk({
      fileName: 'opaque-markdown.js',
      source: 'src/components/ai/MarkdownMessage.tsx',
      code: 'markdown();',
      css: ['ai.css'],
      isDynamicEntry: true,
      modules: ['src/components/ai/MarkdownMessage.tsx'],
    }),
    'shared.js': chunk({
      fileName: 'shared.js',
      code: 'shared();',
      modules: ['src/lib/shared.ts'],
    }),
    'main.css': asset('main.css', '.main { display: block; }'),
    'ai.css': asset('ai.css', '.ai { display: grid; }'),
  };
}


describe('frontend health manifest', () => {
  it('maps logical entry by facade module id, not filename prefix', () => {
    const manifest = createFrontendHealthManifest({
      bundle: completeBundle(),
      entryConfig: ENTRY_CONFIG,
      rootDir: ROOT_DIR,
      commit: COMMIT,
    });

    expect(resolveLogicalEntry('src/components/ai/AiWorkspace.tsx', ENTRY_CONFIG)).toBe('ai');
    expect(manifest.entries.ai).toMatchObject({
      source: 'src/components/ai/AiWorkspace.tsx',
      js: ['opaque-ai.js'],
      imports: ['shared.js'],
      dynamicImports: ['opaque-markdown.js'],
    });
    expect(manifest.manifestErrors).toEqual([]);
  });

  it('associates an HTML entry facade through its source module', () => {
    const manifest = createFrontendHealthManifest({
      bundle: completeBundle(),
      entryConfig: ENTRY_CONFIG,
      rootDir: ROOT_DIR,
      commit: COMMIT,
    });

    expect(manifest.entries.main.js).toEqual(['opaque-main.js']);
    expect(manifest.manifestErrors).toEqual([]);
  });

  it('deduplicates routeTotal shared assets', () => {
    const manifest = createFrontendHealthManifest({
      bundle: completeBundle(),
      entryConfig: ENTRY_CONFIG,
      rootDir: ROOT_DIR,
      commit: COMMIT,
    });

    expect(manifest.entries.ai.routeTotal.assets).toEqual([
      'ai.css',
      'opaque-ai.js',
      'opaque-markdown.js',
      'shared.js',
    ]);
    expect(manifest.entries.ai.routeTotal.gzipBytes).toBe(
      manifest.assets['ai.css'].gzipBytes
      + manifest.assets['opaque-ai.js'].gzipBytes
      + manifest.assets['opaque-markdown.js'].gzipBytes
      + manifest.assets['shared.js'].gzipBytes,
    );
    expect(manifest.shared).toContainEqual({
      asset: 'shared.js',
      entries: ['ai', 'main'],
    });
  });

  it('records raw and gzip bytes with content hash', () => {
    const manifest = createFrontendHealthManifest({
      bundle: completeBundle(),
      entryConfig: ENTRY_CONFIG,
      rootDir: ROOT_DIR,
      commit: COMMIT,
    });
    const code = 'ai();';

    expect(manifest.assets['opaque-ai.js']).toMatchObject({
      rawBytes: Buffer.byteLength(code),
      gzipBytes: gzipSync(code, { level: 9, mtime: 0 }).byteLength,
      sha256: createHash('sha256').update(code).digest('hex'),
      sourceModules: ['src/components/ai/AiWorkspace.tsx'],
    });
  });

  it('reports missing entry, orphan chunk, and unresolved CSS', () => {
    const bundle = completeBundle();
    bundle['orphan.js'] = chunk({
      fileName: 'orphan.js',
      source: 'src/Orphan.tsx',
      code: 'orphan();',
      isDynamicEntry: true,
      modules: ['src/Orphan.tsx'],
    });
    bundle['opaque-ai.js'].viteMetadata.importedCss.add('missing.css');
    const config = {
      ...ENTRY_CONFIG,
      entries: {
        ...ENTRY_CONFIG.entries,
        home: { source: 'src/features/home/HomeDashboard.tsx', dynamic: true },
      },
    };

    const manifest = createFrontendHealthManifest({
      bundle,
      entryConfig: config,
      rootDir: ROOT_DIR,
      commit: COMMIT,
    });

    expect(manifest.manifestErrors).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'missing-entry', entry: 'home' }),
      expect.objectContaining({ type: 'orphan-chunk', asset: 'orphan.js' }),
      expect.objectContaining({ type: 'unresolved-css', asset: 'missing.css' }),
    ]));
  });

  it('detects an unregistered dynamic import after code movement', () => {
    const bundle = completeBundle();
    delete bundle['opaque-ai.js'];
    bundle['moved-ai.js'] = chunk({
      fileName: 'moved-ai.js',
      source: 'src/components/ai/AiWorkspaceMoved.tsx',
      code: 'movedAi();',
      isDynamicEntry: true,
      modules: ['src/components/ai/AiWorkspaceMoved.tsx'],
    });

    const manifest = createFrontendHealthManifest({
      bundle,
      entryConfig: ENTRY_CONFIG,
      rootDir: ROOT_DIR,
      commit: COMMIT,
    });
    const assertion = assertFrontendHealthManifest(manifest, ENTRY_CONFIG);

    expect(assertion.ok).toBe(false);
    expect(assertion.violations).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'unregistered-dynamic-entry', source: 'src/components/ai/AiWorkspaceMoved.tsx' }),
    ]));
  });
});
