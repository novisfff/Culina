import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('App home dashboard dialog composition ownership', () => {
  it('keeps home dialog prop wiring out of App', () => {
    const appSource = readFileSync(resolve(__dirname, '../App.tsx'), 'utf8');
    const builderSource = readFileSync(resolve(__dirname, 'useAppHomeDashboardDialogProps.ts'), 'utf8');

    expect(appSource).toContain('useAppHomeDashboardDialogProps');
    expect(appSource).not.toContain('const homeDashboardDialogProps:');
    expect(builderSource).toContain('export function useAppHomeDashboardDialogProps');
    expect(builderSource).toContain('openHomeMealRecord:');
    expect(builderSource).toContain('onInvalidMealEnrichmentSave:');
  });
});
