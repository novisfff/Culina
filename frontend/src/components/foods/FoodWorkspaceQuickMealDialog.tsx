import type { ComponentProps } from 'react';
import { FoodQuickMealDialog } from './FoodQuickMealDialog';

type FoodWorkspaceQuickMealDialogProps = Omit<ComponentProps<typeof FoodQuickMealDialog>, 'isSubmitting'> & {
  isQuickAdding?: boolean;
  isUpdatingPlan?: boolean;
};

/** Owns the confirmation dialog view while the workspace owns action/state semantics. */
export function FoodWorkspaceQuickMealDialog({
  dialog,
  isQuickAdding,
  isUpdatingPlan,
  ...props
}: FoodWorkspaceQuickMealDialogProps) {
  const isCookAction = dialog.action === 'cook' && dialog.recipeId;
  const isSubmitting = Boolean(isQuickAdding || (isCookAction && isUpdatingPlan));
  return <FoodQuickMealDialog dialog={dialog} isSubmitting={isSubmitting} {...props} />;
}
