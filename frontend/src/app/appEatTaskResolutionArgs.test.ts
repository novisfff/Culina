import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('App Eat task resolution adapter ownership', () => {
  it('keeps query settle state mapping behind a typed adapter', () => {
    const appSource = readFileSync(resolve(__dirname, '../App.tsx'), 'utf8');
    const adapterSource = readFileSync(resolve(__dirname, 'useAppEatTaskResolutionArgs.ts'), 'utf8');

    expect(appSource).toContain('useAppEatTaskResolutionArgs');
    expect(appSource).not.toContain('taskResolutionArgs={{');
    expect(adapterSource).toContain('export function useAppEatTaskResolutionArgs');
    expect(adapterSource).toContain('querySettleStatus');
  });
});
