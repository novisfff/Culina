import type { ComponentProps } from 'react';
import { FoodWorkspaceQuickMealDialog } from './FoodWorkspaceQuickMealDialog';
import { FoodWorkspaceQuickRecordOverlay } from './FoodWorkspaceQuickRecordOverlay';
import { MealRecordResultBar } from '../../features/meals/MealRecordResultBar';

type ResultBarProps = ComponentProps<typeof MealRecordResultBar>;
type QuickRecordProps = ComponentProps<typeof FoodWorkspaceQuickRecordOverlay>;
type QuickMealProps = ComponentProps<typeof FoodWorkspaceQuickMealDialog>;

export type FoodWorkspaceMealOverlaysProps = {
  resultBar: ResultBarProps;
  quickRecord: QuickRecordProps;
  quickMeal: QuickMealProps | null;
};

/** Keeps ordinary record feedback and quick-record/cook dialogs in one overlay boundary. */
export function FoodWorkspaceMealOverlays({ resultBar, quickRecord, quickMeal }: FoodWorkspaceMealOverlaysProps) {
  return (
    <>
      <MealRecordResultBar {...resultBar} />
      <FoodWorkspaceQuickRecordOverlay {...quickRecord} />
      {quickMeal ? <FoodWorkspaceQuickMealDialog {...quickMeal} /> : null}
    </>
  );
}
