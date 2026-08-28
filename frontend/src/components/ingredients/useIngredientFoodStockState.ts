import { useCallback, useState } from 'react';
import type { Food, Ingredient, InventoryOverviewItem, MealLogCandidate, MealType, RecordMealTarget } from '../../api/types';
import type { MealCandidateResolution } from '../../features/meals/MealComposerModel';
import { addDateKeyDays } from '../../lib/date';

export type FoodStockDeductDialogState = {
  item: InventoryOverviewItem;
  stockQuantity: string;
  error: string | null;
};

export type FoodStockInventoryFollowUpState = FoodStockDeductDialogState;

export type FoodQuickRecordState = {
  food: Food;
  item: InventoryOverviewItem;
  date: string;
  mealType: MealType;
  target: RecordMealTarget;
  selectedCandidateId: string | null;
  candidateMode: 'none' | 'single' | 'multi';
  candidates: MealLogCandidate[];
  candidateResolution: MealCandidateResolution;
  targetTouchedByUser: boolean;
  clientRequestId: string;
  busy: boolean;
  error: string | null;
};

export type FoodStockAdjustDialogState = {
  item: InventoryOverviewItem;
  quantity: string;
  unit: string;
  expiryDate: string;
  purchaseSource: string;
  error: string | null;
};

export function useIngredientFoodStockState(todayDate: string) {
  const [quickRecord, setQuickRecord] = useState<FoodQuickRecordState | null>(null);
  const [inventoryFollowUp, setInventoryFollowUp] = useState<FoodStockInventoryFollowUpState | null>(null);
  const [foodStockDeductDialog, setFoodStockDeductDialog] = useState<FoodStockDeductDialogState | null>(null);
  const [foodStockAdjustDialog, setFoodStockAdjustDialog] = useState<FoodStockAdjustDialogState | null>(null);
  const [foodStockSubmitting, setFoodStockSubmitting] = useState<'meal' | 'adjust' | null>(null);

  const setFoodStockRestockQuantity = useCallback((quantity: string) => {
    setFoodStockAdjustDialog((current) => current ? { ...current, quantity, error: null } : current);
  }, []);
  const setFoodStockRestockExpiryDays = useCallback((days: number | null) => {
    setFoodStockAdjustDialog((current) => current ? {
      ...current,
      expiryDate: days === null ? '' : addDateKeyDays(todayDate, days),
      error: null,
    } : current);
  }, [todayDate]);
  const setFoodStockRestockSource = useCallback((purchaseSource: string) => {
    setFoodStockAdjustDialog((current) => current ? { ...current, purchaseSource, error: null } : current);
  }, []);

  return {
    quickRecord,
    setQuickRecord,
    inventoryFollowUp,
    setInventoryFollowUp,
    foodStockDeductDialog,
    setFoodStockDeductDialog,
    foodStockAdjustDialog,
    setFoodStockAdjustDialog,
    foodStockSubmitting,
    setFoodStockSubmitting,
    setFoodStockRestockQuantity,
    setFoodStockRestockExpiryDays,
    setFoodStockRestockSource,
  };
}
