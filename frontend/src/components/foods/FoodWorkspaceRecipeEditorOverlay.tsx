import type { ComponentProps } from 'react';
import { FoodRecipeEditorDialog } from './FoodRecipeEditorDialog';
import { RecipeEditorView } from '../recipes/RecipeEditorView';

type FoodWorkspaceRecipeEditorOverlayProps = {
  dialog: Omit<ComponentProps<typeof FoodRecipeEditorDialog>, 'children'>;
  view: ComponentProps<typeof RecipeEditorView>;
};

/** Recipe editor route boundary; the workspace supplies state and typed actions. */
export function FoodWorkspaceRecipeEditorOverlay({
  dialog,
  view,
}: FoodWorkspaceRecipeEditorOverlayProps) {
  return (
    <FoodRecipeEditorDialog {...dialog}>
      <RecipeEditorView {...view} />
    </FoodRecipeEditorDialog>
  );
}
