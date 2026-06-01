import type { ReactNode } from 'react';
import type { Ingredient, Recipe } from '../../api/types';
import type { OverlayLayerProps } from './IngredientWorkspaceOverlayTypes';
import { IngredientDetailView } from './IngredientDetailView';
import { IngredientWorkspaceFrame } from './IngredientWorkspaceFrame';
import type { IngredientSummaryViewModel } from './workspaceModel';

type DetailMetricItem = {
  label: string;
  value: string;
  tone: string;
  icon: string;
};

type IngredientDetailPageProps = {
  noticeToast: ReactNode;
  overlays: OverlayLayerProps;
  activePanelBackLabel: string;
  selectedIngredient: IngredientSummaryViewModel;
  detailStorageLabel: string;
  detailMetricItems: DetailMetricItem[];
  recipes: Recipe[];
  onOpenCreateView: () => void;
  goBackToWorkspace: () => void;
  openInventoryOverlay: (ingredientId?: string) => void;
  openConsumeOverlay: (ingredientId: string) => void;
  openShoppingOverlay: (options?: { ingredient?: Ingredient; reason?: string }) => void;
  openEditView: (ingredient: Ingredient) => void;
  renderIcon: (name: string) => ReactNode;
  formatExpiryRuleLabel: (ingredient: Ingredient) => string;
  formatLowStockRuleLabel: (ingredient: Ingredient) => string;
};

export function IngredientDetailPage(props: IngredientDetailPageProps) {
  return (
    <IngredientWorkspaceFrame
      noticeToast={props.noticeToast}
      mobileQuickBar={{
        onCreate: props.onOpenCreateView,
        onInventory: () => props.openInventoryOverlay(props.selectedIngredient.ingredient.id),
        onShopping: () =>
          props.openShoppingOverlay({
            ingredient: props.selectedIngredient.ingredient,
            reason: '库存偏低，准备补货',
          }),
      }}
      overlays={props.overlays}
    >
      <IngredientDetailView
        activePanelBackLabel={props.activePanelBackLabel}
        detailStorageLabel={props.detailStorageLabel}
        detailMetricItems={props.detailMetricItems}
        selectedIngredient={props.selectedIngredient}
        recipes={props.recipes}
        goBackToWorkspace={props.goBackToWorkspace}
        openInventoryOverlay={props.openInventoryOverlay}
        openConsumeOverlay={props.openConsumeOverlay}
        openShoppingOverlay={props.openShoppingOverlay}
        openEditView={props.openEditView}
        renderIcon={props.renderIcon}
        formatExpiryRuleLabel={props.formatExpiryRuleLabel}
        formatLowStockRuleLabel={props.formatLowStockRuleLabel}
      />
    </IngredientWorkspaceFrame>
  );
}
