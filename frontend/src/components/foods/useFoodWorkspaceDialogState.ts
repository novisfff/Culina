import { useState } from 'react';
import type { FoodQuickMealDialogState } from './FoodQuickMealDialog';
import type { FoodQuickRecordState } from './FoodQuickRecordState';

export type MobileCookingFilter = 'all' | 'ready' | 'shortage';

export function useFoodWorkspaceDialogState() {
  const [quickMealDialog, setQuickMealDialog] = useState<FoodQuickMealDialogState | null>(null);
  const [quickRecord, setQuickRecord] = useState<FoodQuickRecordState | null>(null);
  const [isFoodRecipeEditorOpen, setIsFoodRecipeEditorOpen] = useState(false);
  const [mobileCookingFilter, setMobileCookingFilter] = useState<MobileCookingFilter>('all');

  return {
    quickMealDialog,
    setQuickMealDialog,
    quickRecord,
    setQuickRecord,
    isFoodRecipeEditorOpen,
    setIsFoodRecipeEditorOpen,
    mobileCookingFilter,
    setMobileCookingFilter,
  };
}
