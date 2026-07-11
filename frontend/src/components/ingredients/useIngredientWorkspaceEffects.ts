import { useEffect } from 'react';
import type { Dispatch, RefObject, SetStateAction } from 'react';
import type { Ingredient } from '../../api/types';
import { defaultIngredientForm, type IngredientCreateFormState } from './ingredientWorkspaceForms';
import type { IngredientSummaryViewModel, IngredientWorkspaceView } from './workspaceModel';
type UseIngredientWorkspaceEffectsArgs = {
  ingredients: Ingredient[];
  transientIngredient: Ingredient | null;
  setTransientIngredient: Dispatch<SetStateAction<Ingredient | null>>;
  selectedIngredientId: string | null;
  setSelectedIngredientId: Dispatch<SetStateAction<string | null>>;
  summaries: IngredientSummaryViewModel[];
  expandedCatalogIngredientId: string | null;
  setExpandedCatalogIngredientId: Dispatch<SetStateAction<string | null>>;
  filteredSummaries: IngredientSummaryViewModel[];
  editingIngredientId: string | null;
  setEditingIngredientId: Dispatch<SetStateAction<string | null>>;
  ingredientOptions: Ingredient[];
  workspaceView: IngredientWorkspaceView;
  setIngredientForm: Dispatch<SetStateAction<IngredientCreateFormState>>;
  showCompletedShopping: boolean;
  setShowCompletedShopping: Dispatch<SetStateAction<boolean>>;
  completedShoppingCount: number;
  catalogCategoryFilter: string;
  catalogCategories: string[];
  setCatalogCategoryFilter: Dispatch<SetStateAction<'all' | string>>;
  activePanel: 'catalog' | 'inventory' | 'shopping';
  catalogMeasureRef: RefObject<HTMLDivElement>;
  maxCatalogItems: number;
  setCatalogColumns: Dispatch<SetStateAction<number>>;
  setCatalogCardWidth: Dispatch<SetStateAction<number>>;
  storageShelfIdealWidth: number;
  storageShelfMaxDisplayColumns: number;
};

export function useIngredientWorkspaceEffects(args: UseIngredientWorkspaceEffectsArgs) {
  useEffect(() => {
    if (!args.transientIngredient) {
      return;
    }
    const server = args.ingredients.find((item) => item.id === args.transientIngredient?.id);
    if (!server) {
      return;
    }
    // Keep a local post-transition snapshot until the query cache catches up to its row_version.
    const transientVersion = args.transientIngredient.row_version ?? 0;
    const serverVersion = server.row_version ?? 0;
    if (serverVersion >= transientVersion) {
      args.setTransientIngredient(null);
    }
  }, [args.ingredients, args.transientIngredient, args.setTransientIngredient]);

  useEffect(() => {
    if (!args.selectedIngredientId && args.summaries[0]) {
      args.setSelectedIngredientId(args.summaries[0].ingredient.id);
      return;
    }
    if (
      args.selectedIngredientId &&
      !args.summaries.some((item) => item.ingredient.id === args.selectedIngredientId)
    ) {
      args.setSelectedIngredientId(args.summaries[0]?.ingredient.id ?? null);
    }
  }, [args.selectedIngredientId, args.summaries, args.setSelectedIngredientId]);

  useEffect(() => {
    if (
      args.expandedCatalogIngredientId &&
      !args.filteredSummaries.some((item) => item.ingredient.id === args.expandedCatalogIngredientId)
    ) {
      args.setExpandedCatalogIngredientId(null);
    }
  }, [args.expandedCatalogIngredientId, args.filteredSummaries, args.setExpandedCatalogIngredientId]);

  useEffect(() => {
    if (args.editingIngredientId && !args.ingredientOptions.some((item) => item.id === args.editingIngredientId)) {
      args.setEditingIngredientId(null);
      if (args.workspaceView === 'create') {
        args.setIngredientForm(defaultIngredientForm());
      }
    }
  }, [
    args.editingIngredientId,
    args.ingredientOptions,
    args.workspaceView,
    args.setEditingIngredientId,
    args.setIngredientForm,
  ]);

  useEffect(() => {
    if (args.showCompletedShopping && args.completedShoppingCount === 0) {
      args.setShowCompletedShopping(false);
    }
  }, [args.completedShoppingCount, args.showCompletedShopping, args.setShowCompletedShopping]);

  useEffect(() => {
    if (args.catalogCategoryFilter !== 'all' && !args.catalogCategories.includes(args.catalogCategoryFilter)) {
      args.setCatalogCategoryFilter('all');
    }
  }, [
    args.catalogCategories,
    args.catalogCategoryFilter,
    args.setCatalogCategoryFilter,
  ]);

  useEffect(() => {
    if (args.activePanel !== 'catalog' || args.workspaceView !== 'hub') {
      return;
    }

    const target = args.catalogMeasureRef.current;
    if (!target) {
      return;
    }

    const updateLayout = (availableWidth: number) => {
      const safeMaxGroupItems = Math.max(1, args.maxCatalogItems);
      const maxDisplayColumns = Math.min(safeMaxGroupItems, args.storageShelfMaxDisplayColumns);
      if (availableWidth <= 0) {
        args.setCatalogColumns(1);
        args.setCatalogCardWidth(args.storageShelfIdealWidth);
        return;
      }

      const minColumns = Math.max(1, Math.ceil((availableWidth + 18) / (318 + 18)));
      const maxColumns = Math.max(1, Math.floor((availableWidth + 18) / (226 + 18)));
      const lowerBound = Math.min(maxDisplayColumns, minColumns);
      const upperBound = Math.min(maxDisplayColumns, Math.max(lowerBound, maxColumns));
      const candidates =
        lowerBound <= upperBound
          ? Array.from({ length: upperBound - lowerBound + 1 }, (_, index) => lowerBound + index)
          : Array.from({ length: maxDisplayColumns }, (_, index) => index + 1);

      let bestColumns = candidates[0] ?? 1;
      let bestCardWidth = (availableWidth - 18 * (bestColumns - 1)) / bestColumns;

      for (const candidate of candidates) {
        const nextCardWidth = (availableWidth - 18 * (candidate - 1)) / candidate;
        const nextDeviation = Math.abs(nextCardWidth - args.storageShelfIdealWidth);
        const bestDeviation = Math.abs(bestCardWidth - args.storageShelfIdealWidth);

        if (
          nextDeviation < bestDeviation - 0.01 ||
          (Math.abs(nextDeviation - bestDeviation) < 0.01 && candidate > bestColumns)
        ) {
          bestColumns = candidate;
          bestCardWidth = nextCardWidth;
        }
      }

      args.setCatalogColumns((current) => (current === bestColumns ? current : bestColumns));
      args.setCatalogCardWidth((current) =>
        Math.abs(current - Number(bestCardWidth.toFixed(2))) < 0.01 ? current : Number(bestCardWidth.toFixed(2))
      );
    };

    updateLayout(target.clientWidth);

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      updateLayout(entry?.contentRect.width ?? target.clientWidth);
    });

    observer.observe(target);

    return () => {
      observer.disconnect();
    };
  }, [
    args.activePanel,
    args.workspaceView,
    args.maxCatalogItems,
    args.catalogMeasureRef,
    args.setCatalogColumns,
    args.setCatalogCardWidth,
    args.storageShelfIdealWidth,
    args.storageShelfMaxDisplayColumns,
  ]);
}
