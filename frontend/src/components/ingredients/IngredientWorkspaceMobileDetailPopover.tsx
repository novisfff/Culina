import type { ComponentProps } from 'react';
import { WorkspaceDrawer, WorkspaceOverlayFrame } from '../ui-kit';
import { IngredientDetailView } from './IngredientDetailView';

type IngredientWorkspaceMobileDetailPopoverProps = {
  detailViewProps: ComponentProps<typeof IngredientDetailView>;
  onClose: () => void;
};

/** Mobile detail route overlay; desktop detail remains a dedicated page. */
export function IngredientWorkspaceMobileDetailPopover({
  detailViewProps,
  onClose,
}: IngredientWorkspaceMobileDetailPopoverProps) {
  const { selectedIngredient } = detailViewProps;

  return (
    <WorkspaceOverlayFrame
      rootClassName="ingredient-workspace-overlay-root mobile-ingredient-detail-popover-root"
      backdropClassName="mobile-ingredient-detail-popover-backdrop"
      onClose={onClose}
    >
      <WorkspaceDrawer
        eyebrow={selectedIngredient.ingredient.category || '食材'}
        title={selectedIngredient.ingredient.name}
        description={
          selectedIngredient.ingredient.notes ||
          `适合做${selectedIngredient.recipeReferences.slice(0, 2).map((recipe) => recipe.title).join('、') || '日常菜'}`
        }
        closeLabel="关闭"
        closeAriaLabel="关闭食材详情"
        className="mobile-ingredient-detail-popover-panel ingredient-detail-drawer"
        onClose={onClose}
      >
        <IngredientDetailView {...detailViewProps} />
      </WorkspaceDrawer>
    </WorkspaceOverlayFrame>
  );
}
