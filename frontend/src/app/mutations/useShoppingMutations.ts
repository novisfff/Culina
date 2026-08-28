import type { AppMutationRegistry } from '../useAppMutations';
export function useShoppingMutationActions(m: AppMutationRegistry) { return { createShoppingMutation: m.createShoppingMutation, updateShoppingMutation: m.updateShoppingMutation, deleteShoppingMutation: m.deleteShoppingMutation }; }
