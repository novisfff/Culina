import { describe, expect, it } from 'vitest';
import { resolveAppOverlayState } from './appOverlayState';

describe('resolveAppOverlayState', () => {
  it('applies overlay priority from global to maintenance', () => {
    expect(resolveAppOverlayState({ globalSearchOpen: true, homeShoppingOpen: true, inventoryMaintenanceOpen: true })).toEqual({ kind: 'global-search' });
    expect(resolveAppOverlayState({ globalSearchOpen: false, homeShoppingOpen: true, inventoryMaintenanceOpen: true })).toEqual({ kind: 'ingredient-shopping', ingredientId: 'home' });
    expect(resolveAppOverlayState({ globalSearchOpen: false, homeShoppingOpen: false, inventoryMaintenanceOpen: true, inventoryBusy: true })).toEqual({ kind: 'inventory-maintenance', busy: true });
  });

  it('returns none when no overlay is open', () => {
    expect(resolveAppOverlayState({ globalSearchOpen: false, homeShoppingOpen: false, inventoryMaintenanceOpen: false })).toEqual({ kind: 'none' });
  });
});
