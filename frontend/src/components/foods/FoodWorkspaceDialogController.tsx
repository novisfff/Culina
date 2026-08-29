import type { ComponentProps, ReactNode } from 'react';
import { MealEnrichmentModal } from '../../features/meals/MealEnrichmentModal';
import { MealRecordResultBar } from '../../features/meals/MealRecordResultBar';
import { FoodQuickMealDialog } from './FoodQuickMealDialog';
import { FoodRecipeEditorDialog } from './FoodRecipeEditorDialog';
import { FoodSceneDialogs } from './FoodSceneDialogs';
import { FoodWorkspaceDetailOverlay } from './FoodWorkspaceDetailOverlay';
import { FoodWorkspaceEditorOverlay } from './FoodWorkspaceEditorOverlay';
import { FoodWorkspacePlanOverlays } from './FoodWorkspacePlanOverlays';
import { FoodWorkspaceQuickRecordOverlay } from './FoodWorkspaceQuickRecordOverlay';
import { FoodWorkspaceShoppingOverlays } from './FoodWorkspaceShoppingOverlays';

type RecipeEditorProps = ComponentProps<typeof FoodRecipeEditorDialog> & { children: ReactNode };

export type FoodWorkspaceDialogControllerProps = {
  shopping?: ComponentProps<typeof FoodWorkspaceShoppingOverlays>;
  editor?: ComponentProps<typeof FoodWorkspaceEditorOverlay>;
  recipeEditor?: RecipeEditorProps | null;
  result?: ComponentProps<typeof MealRecordResultBar>;
  quickRecord?: ComponentProps<typeof FoodWorkspaceQuickRecordOverlay>;
  quickMeal?: ComponentProps<typeof FoodQuickMealDialog> | null;
  detail?: ComponentProps<typeof FoodWorkspaceDetailOverlay>;
  plan?: ComponentProps<typeof FoodWorkspacePlanOverlays>;
  enrichment?: ComponentProps<typeof MealEnrichmentModal>;
  scenes?: ComponentProps<typeof FoodSceneDialogs>;
};

/** Owns the Food workspace's dialog/overlay composition without owning state or API effects. */
export function FoodWorkspaceDialogController({
  shopping,
  editor,
  recipeEditor,
  result,
  quickRecord,
  quickMeal,
  detail,
  plan,
  enrichment,
  scenes,
}: FoodWorkspaceDialogControllerProps) {
  return (
    <>
      {shopping ? <FoodWorkspaceShoppingOverlays {...shopping} /> : null}
      {editor ? <FoodWorkspaceEditorOverlay {...editor} /> : null}
      {recipeEditor ? <FoodRecipeEditorDialog {...recipeEditor} /> : null}
      {result ? <MealRecordResultBar {...result} /> : null}
      {quickRecord ? <FoodWorkspaceQuickRecordOverlay {...quickRecord} /> : null}
      {quickMeal ? <FoodQuickMealDialog {...quickMeal} /> : null}
      {detail ? <FoodWorkspaceDetailOverlay {...detail} /> : null}
      {plan ? <FoodWorkspacePlanOverlays {...plan} /> : null}
      {enrichment ? <MealEnrichmentModal {...enrichment} /> : null}
      {scenes ? <FoodSceneDialogs {...scenes} /> : null}
    </>
  );
}
