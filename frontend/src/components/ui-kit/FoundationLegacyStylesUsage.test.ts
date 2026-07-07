import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = resolve(__dirname, '../../..');
const srcRoot = resolve(repoRoot, 'src');

const staleFoundationClasses = [
  'badge-inline-icon',
  'conversation-card',
  'food-card-body',
  'food-grid',
  'form-actions-spread',
  'inline-actions',
  'media-preview',
  'metric-strip',
  'page-grid',
  'page-main-column',
  'page-side-column',
  'prompt-line',
  'sidebar-activity',
  'shell-actions',
  'shell-active-badge',
  'shell-activity',
  'shell-content-brand',
  'shell-summary-chip',
  'shell-summary-row',
  'shell-title-row',
  'stats-row',
  'topbar-actions',
  'toolbar-inline',
  'workspace-toolbar-main',
  'workspace-toolbar-stack',
  'cover-image',
  'cover-placeholder',
  'selection-list',
  'selection-card',
  'selection-details',
  'shopping-card-inline',
  'ui-form-field',
  'ui-form-field-label',
  'ui-form-field-control',
  'ui-form-field-hint',
  'ui-form-field-error',
  'ui-form-field-required',
];

function collectNonTestSourceFiles(dir: string): string[] {
  return readdirSync(dir)
    .flatMap((entry) => {
      const path = join(dir, entry);
      const stats = statSync(path);

      if (stats.isDirectory()) {
        return collectNonTestSourceFiles(path);
      }

      if (!stats.isFile()) {
        return [];
      }

      if (!/\.(css|ts|tsx)$/.test(path) || /\.test\.(ts|tsx)$/.test(path)) {
        return [];
      }

      return [path];
    });
}

describe('Foundation legacy style cleanup', () => {
  it('keeps shared foundation styles free of stale helper classes', () => {
    const sourceByFile = collectNonTestSourceFiles(srcRoot).map((path) => ({
      label: relative(repoRoot, path),
      source: readFileSync(path, 'utf8'),
    }));

    for (const className of staleFoundationClasses) {
      const matches = sourceByFile
        .filter(({ source }) => source.includes(className))
        .map(({ label }) => label);

      expect(matches, `${className} is still referenced in ${matches.join(', ')}`).toEqual([]);
    }
  });
});
