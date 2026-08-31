import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('App overlay composition ownership', () => {
  it('keeps toast, notification and overlay state composition out of App', () => {
    const appSource = readFileSync(resolve(__dirname, '../App.tsx'), 'utf8');
    const builderSource = readFileSync(resolve(__dirname, 'useAppOverlayComposition.tsx'), 'utf8');

    expect(appSource).toContain('useAppOverlayComposition');
    expect(appSource).not.toContain('const noticeToast = notice ?');
    expect(builderSource).toContain('export function useAppOverlayComposition');
    expect(builderSource).toContain('resolveAppOverlayState');
  });
});
