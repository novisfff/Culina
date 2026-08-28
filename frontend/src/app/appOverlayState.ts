export type AppOverlayState =
  | { kind: 'none' }
  | { kind: 'global-search'; busy?: boolean }
  | { kind: 'home-dialogs'; dialog: 'shopping' | 'food-plan' | 'quick-meal'; busy?: boolean }
  | { kind: 'inventory-operation-history'; operationId?: string; busy?: boolean }
  | { kind: 'ingredient-shopping'; ingredientId: string; busy?: boolean };

export type NormalizedOverlayState = AppOverlayState & { canEscapeClose: boolean };

export function normalizeOverlayState(state: AppOverlayState): NormalizedOverlayState {
  if (state.kind === 'none') return state as NormalizedOverlayState;
  return { ...state, canEscapeClose: state.busy !== true };
}
