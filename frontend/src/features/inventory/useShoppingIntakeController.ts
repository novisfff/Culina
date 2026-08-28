import { useMemo } from 'react';
import type { Food } from '../../api/types/food';
import type { Ingredient, IngredientInventoryState, ShoppingListItem } from '../../api/types/inventory';
import { tracksIngredientQuantity } from '../../lib/ingredientTracking';
import {
  buildFreeTextLinkOptions,
  linkFreeTextDraft,
  suggestFreeTextLinkCandidates,
  type FreeTextLinkCandidate,
  type FreeTextLinkTarget,
  type ShoppingIntakeDraft,
} from './shoppingIntakeModel';
import { useShoppingIntakeState } from './useShoppingIntakeState';

export function useShoppingIntakeController(args: {
  shoppingItems: ShoppingListItem[];
  ingredients: Ingredient[];
  foods: Food[];
  inventoryStates: IngredientInventoryState[];
  referenceDate: string;
}) {
  const state = useShoppingIntakeState();
  const openShoppingIntake = (selectedItemId?: string) => state.openIntake({ ...args, selectedItemId });
  const candidatesByItemId = useMemo(() => {
    if (!state.draft) return {} as Record<string, FreeTextLinkCandidate[]>;
    return Object.fromEntries(
      state.draft.items
        .filter((item) => item.kind === 'free_text')
        .map((item) => [item.shoppingItemId, suggestFreeTextLinkCandidates({ title: item.title, ingredients: args.ingredients, foods: args.foods })]),
    ) as Record<string, FreeTextLinkCandidate[]>;
  }, [state.draft, args.ingredients, args.foods]);
  const linkOptions = useMemo(() => buildFreeTextLinkOptions(args), [args.ingredients, args.foods]);
  const resolveTarget = (candidate: FreeTextLinkCandidate): FreeTextLinkTarget | null => {
    if (candidate.kind === 'food') {
      const food = args.foods.find((item) => item.id === candidate.id);
      return food ? { kind: 'food', food } : null;
    }
    const ingredient = args.ingredients.find((item) => item.id === candidate.id);
    if (!ingredient) return null;
    const stateEntry = args.inventoryStates.find((item) => item.ingredient_id === ingredient.id) ?? null;
    return tracksIngredientQuantity(ingredient)
      ? { kind: 'exact_ingredient', ingredient, state: stateEntry }
      : { kind: 'presence_ingredient', ingredient, state: stateEntry };
  };
  const linkCandidate = (shoppingItemId: string, candidate: FreeTextLinkCandidate) => {
    const target = resolveTarget(candidate);
    if (!target || !state.draft) return;
    state.replaceDraft(linkFreeTextDraft(state.draft, shoppingItemId, target, state.draft.purchaseDate));
  };
  return { ...state, openShoppingIntake, candidatesByItemId, linkOptions, linkCandidate };
}
