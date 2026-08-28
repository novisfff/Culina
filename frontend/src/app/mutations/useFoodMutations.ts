import type { AppMutationRegistry } from '../useAppMutations';
export function useFoodMutationActions(m: AppMutationRegistry) { return { createFoodMutation: m.createFoodMutation, updateFoodMutation: m.updateFoodMutation, toggleFavoriteMutation: m.toggleFavoriteMutation }; }
