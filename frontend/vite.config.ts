import { configDefaults, defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import bundleEntrypoints from './scripts/bundle-entrypoints.json';

// The manifest builder is a Node ESM script so it can be tested independently of Vite.
import { viteFrontendHealthManifestPlugin } from './scripts/bundle-manifest.mjs';

export default defineConfig({
  plugins: [react(), viteFrontendHealthManifestPlugin({ entryConfig: bundleEntrypoints })],
  build: {
    manifest: true,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('/node_modules/react-markdown/') || id.includes('/node_modules/remark-gfm/')) {
            return 'ai-markdown-vendor';
          }
          if (id.includes('/node_modules/@tanstack/react-query/') || id.includes('/node_modules/@tanstack/query-core/')) {
            return 'react-query-vendor';
          }
          if (id.includes('/node_modules/react/') || id.includes('/node_modules/react-dom/') || id.includes('/node_modules/scheduler/')) {
            return 'react-vendor';
          }
          return undefined;
        },
      },
    },
  },
  server: {
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8010',
        changeOrigin: true,
        ws: true,
      },
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    exclude: [...configDefaults.exclude, 'e2e/**'],
    // Several workspace tests exercise real async rendering paths. Run files
    // serially so their behavioral timeouts are not starved by unrelated JSDOM work.
    fileParallelism: false,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary'],
      reportsDirectory: './coverage',
      include: ['src/**/*.{ts,tsx}'],
      exclude: ['src/**/*.test.{ts,tsx}', 'src/test/**', 'src/vite-env.d.ts'],
    },
  },
});
