import type { AppMutationRegistry } from '../useAppMutations';
export function useIngredientMutationActions(m: AppMutationRegistry) {
  return { createIngredientMutation: m.createIngredientMutation, updateIngredientMutation: m.updateIngredientMutation, transitionIngredientTrackingModeMutation: m.transitionIngredientTrackingModeMutation };
}
