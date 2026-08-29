import type { Dispatch, SetStateAction } from 'react';
import type { Food, MealType, Recipe } from '../../api/types/food';
import { createFoodRecordClientRequestId, type FoodQuickRecordState } from './FoodQuickRecordState';
import { getQuickDefaultMealType, normalizeFoodType } from './FoodWorkspaceHelpers';
import type { FoodQuickMealDialogState } from './FoodQuickMealDialog';

type SetQuickMealDialog = Dispatch<SetStateAction<FoodQuickMealDialogState | null>>;
type SetQuickRecord = Dispatch<SetStateAction<FoodQuickRecordState | null>>;

export function useFoodQuickMealActions(args: {
  recipes: Recipe[];
  mealBusinessDate: string;
  suggestedMealType: MealType;
  setQuickMealDialog: SetQuickMealDialog;
  setQuickRecord: SetQuickRecord;
}) {
  function openCookConfirmDialog(food: Food, mealType: MealType, options?: { date?: string }) {
    const recipeId = food.recipe_id ?? undefined;
    const recipeServings = recipeId != null ? args.recipes.find((recipe) => recipe.id === recipeId)?.servings : undefined;
    args.setQuickMealDialog({
      action: 'cook',
      date: options?.date ?? args.mealBusinessDate,
      food,
      mealType,
      recipeId,
      servings: recipeServings && recipeServings > 0 ? recipeServings : 1,
    });
  }

  function openCompactRecord(food: Food, fallbackMealType?: MealType, options?: { date?: string }) {
    args.setQuickRecord({
      food,
      date: options?.date ?? args.mealBusinessDate,
      mealType: getQuickDefaultMealType(food, fallbackMealType ?? args.suggestedMealType),
      target: { kind: 'new' },
      selectedCandidateId: null,
      candidateMode: 'none',
      candidates: [],
      candidateResolution: { status: 'loading' },
      targetTouchedByUser: false,
      clientRequestId: createFoodRecordClientRequestId(),
      busy: false,
      error: null,
    });
  }

  function openQuickMealDialog(food: Food, mealType: MealType, action: FoodQuickMealDialogState['action'], options?: { date?: string }) {
    if (action === 'cook' && food.recipe_id) {
      openCookConfirmDialog(food, mealType, options);
      return;
    }
    openCompactRecord(food, mealType, options);
  }

  function updateQuickMealDialog(patch: Partial<Pick<FoodQuickMealDialogState, 'date' | 'mealType' | 'servings'>>) {
    args.setQuickMealDialog((current) => (current ? { ...current, ...patch } : current));
  }

  function handleFoodCardPrimaryAction(food: Food, mealType: MealType) {
    const initialMealType = getQuickDefaultMealType(food, args.suggestedMealType);
    openQuickMealDialog(food, initialMealType, normalizeFoodType(food) === 'selfMade' && food.recipe_id ? 'cook' : 'eat');
  }

  return { openCookConfirmDialog, openCompactRecord, openQuickMealDialog, updateQuickMealDialog, handleFoodCardPrimaryAction };
}
