export type AppOverlayState =
  | { kind: 'none' }
  | { kind: 'global-search'; busy?: boolean }
  | { kind: 'home-dialogs'; dialog: 'shopping' | 'food-plan' | 'quick-meal'; busy?: boolean }
  | { kind: 'inventory-operation-history'; operationId?: string; busy?: boolean }
  | { kind: 'inventory-maintenance'; busy?: boolean }
  | { kind: 'ingredient-shopping'; ingredientId: string; busy?: boolean };

export type NormalizedOverlayState = AppOverlayState & { canEscapeClose: boolean };

export function resolveAppOverlayState(args: {
  globalSearchOpen: boolean;
  homeShoppingOpen: boolean;
  inventoryMaintenanceOpen: boolean;
  inventoryBusy?: boolean;
}): AppOverlayState {
  if (args.globalSearchOpen) return { kind: 'global-search' };
  if (args.homeShoppingOpen) return { kind: 'ingredient-shopping', ingredientId: 'home' };
  if (args.inventoryMaintenanceOpen) return { kind: 'inventory-maintenance', busy: args.inventoryBusy };
  return { kind: 'none' };
}

export function normalizeOverlayState(state: AppOverlayState): NormalizedOverlayState {
  if (state.kind === 'none') return state as NormalizedOverlayState;
  return { ...state, canEscapeClose: state.busy !== true };
}
