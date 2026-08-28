import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { normalizeOverlayState, type AppOverlayState } from './appOverlayState';

describe('AppOverlayHost overlay contract', () => {
  it('exposes normalized state to the typed overlay renderer', () => {
    const appSource = readFileSync(resolve(__dirname, '../App.tsx'), 'utf8');
    const hostSource = readFileSync(resolve(__dirname, './AppOverlayHost.tsx'), 'utf8');
    expect(appSource).not.toContain("import('./features/home/HomeDashboardDialogs')");
    expect(hostSource).toContain('AppHomeDashboardDialogs');
    expect(appSource).not.toContain("import('./features/inventory/InventoryMaintenanceDialogs')");
    expect(hostSource).toContain('AppInventoryMaintenanceDialogs');
    expect(appSource).not.toContain('<AppGlobalOverlays');
    expect(hostSource).toContain('AppGlobalOverlays');
    expect(hostSource).toContain('NormalizedOverlayState');
    expect(hostSource).toContain('AppOverlayContent');
  });

  it('represents no overlay as a single discriminated state', () => {
    expect(normalizeOverlayState({ kind: 'none' })).toEqual({ kind: 'none' });
  });
  it('does not allow busy overlays to close via escape', () => {
    const state: AppOverlayState = { kind: 'home-dialogs', dialog: 'shopping', busy: true };
    expect(normalizeOverlayState(state).canEscapeClose).toBe(false);
  });
});
