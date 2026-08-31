import type { Ingredient, IngredientInventoryState, InventoryItem, ShoppingListItem } from '../../api/types';
import {
  buildInventoryActionGroups,
  type InventoryActionGroup,
} from '../../features/inventory/inventoryActionModel';
import type {
  IngredientAlertViewModel,
  InventoryCardStatusViewModel,
} from './workspaceTypes';

export function buildIngredientAlerts(
  inventoryItems: InventoryItem[],
  ingredients: Ingredient[],
  today: string,
  shoppingItems: ShoppingListItem[] = [],
  inventoryStates: IngredientInventoryState[] = [],
) {
  const groups = buildInventoryActionGroups({
    inventoryItems,
    ingredients,
    shoppingItems,
    inventoryStates,
    referenceDate: today,
  });
  return inventoryActionGroupsToAlerts(groups, ingredients);
}

export function inventoryActionGroupsToAlerts(
  groups: InventoryActionGroup[],
  ingredients: Ingredient[],
): IngredientAlertViewModel[] {
  const ingredientById = new Map(ingredients.map((ingredient) => [ingredient.id, ingredient]));
  return groups.map((group) => {
    const ingredient = ingredientById.get(group.ingredientId);
    if (group.kind === 'low_stock') {
      return {
        id: group.id,
        ingredientId: group.ingredientId,
        ingredientName: group.ingredientName,
        title: group.title,
        detail: group.detail,
        tone: 'warning' as const,
        kind: 'lowStock' as const,
        storageLocation: ingredient?.default_storage || '',
      };
    }
    return {
      id: group.id,
      ingredientId: group.ingredientId,
      ingredientName: group.ingredientName,
      title: group.title,
      detail: group.detail,
      tone: group.severity === 'expires_later' ? 'warning' as const : 'danger' as const,
      kind: 'expiry' as const,
      severity: group.severity,
      storageLocation: group.storageLocations[0] || ingredient?.default_storage || '',
    };
  });
}

export function buildIngredientPriorityActionGroups(args: {
  inventoryItems: InventoryItem[];
  ingredients: Ingredient[];
  shoppingItems?: ShoppingListItem[];
  inventoryStates?: IngredientInventoryState[];
  referenceDate: string;
}) {
  return buildInventoryActionGroups({
    inventoryItems: args.inventoryItems,
    ingredients: args.ingredients,
    shoppingItems: args.shoppingItems ?? [],
    inventoryStates: args.inventoryStates ?? [],
    referenceDate: args.referenceDate,
  });
}

export type PrioritySurfaceShoppingBinding = {
  ingredientId: string;
  ingredientName: string;
  reason: string;
};

export type PrioritySurfaceRow = {
  group: InventoryActionGroup;
  shoppingBinding: PrioritySurfaceShoppingBinding | null;
};

export function buildPrioritySurfaceRows(groups: InventoryActionGroup[]): PrioritySurfaceRow[] {
  return groups.map((group) => ({
    group,
    shoppingBinding: group.kind === 'low_stock'
      ? { ingredientId: group.ingredientId, ingredientName: group.ingredientName, reason: '库存不足' }
      : null,
  }));
}

export function buildPriorityGroupStatus(group: InventoryActionGroup): InventoryCardStatusViewModel {
  if (group.kind === 'low_stock') return { label: '库存偏低', tone: 'warning', detail: group.detail, priority: 2 };
  if (group.severity === 'expires_later') return { label: '临期或过期', tone: 'warning', detail: group.detail, priority: 2 };
  return { label: '临期或过期', tone: 'danger', detail: group.detail, priority: 3 };
}

export function getPriorityGroupPrimaryLabel(group: InventoryActionGroup) {
  if (group.kind === 'low_stock') return '加入采购清单';
  return group.severity === 'expired' ? '处理过期库存' : '处理临期库存';
}
