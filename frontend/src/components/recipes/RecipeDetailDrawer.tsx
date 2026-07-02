import type { ComponentProps } from 'react';
import { WorkspaceDrawer } from '../ui-kit';
import { RecipeDetailView } from './RecipeDetailView';

type RecipeDetailDrawerProps = Omit<ComponentProps<typeof RecipeDetailView>, 'backLabel' | 'compactHeader' | 'onBack' | 'showHeroTitle'> & {
  onClose: () => void;
};

export function RecipeDetailDrawer({ onClose, ...props }: RecipeDetailDrawerProps) {
  const metaLine = `${props.selectedCard.recipe.prep_minutes} 分钟 · ${props.selectedCard.recipe.servings} 人份 · ${props.selectedCard.availabilityLabel}`;

  return (
    <div className="workspace-overlay-root recipe-workspace-overlay-root">
      <div className="workspace-overlay-backdrop" onClick={onClose} />
      <WorkspaceDrawer
        eyebrow="菜谱资料"
        title={props.selectedCard.recipe.title}
        description={metaLine}
        className="recipe-detail-drawer"
        closeLabel="关闭"
        onClose={onClose}
      >
        <RecipeDetailView
          {...props}
          compactHeader
          showHeroTitle={false}
          backLabel="返回菜谱"
          onBack={onClose}
        />
      </WorkspaceDrawer>
    </div>
  );
}
