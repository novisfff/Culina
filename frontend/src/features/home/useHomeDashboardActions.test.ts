import { describe, expect, it, vi } from 'vitest';
import type { FormEvent } from 'react';
import type { DisposeExpiredInventoryRequest, Ingredient } from '../../api/types';
import type {
  DisposableExpiredInventoryItemViewModel,
  IngredientSummaryViewModel,
} from '../../components/ingredients/workspaceModel';
import { useHomeDashboardActions } from './useHomeDashboardActions';

const ingredient: Ingredient = {
  id: 'ingredient-tomato',
  family_id: 'family-1',
  name: '番茄',
  category: '蔬菜',
  default_unit: '个',
  unit_conversions: [],
  default_storage: '冷藏',
  default_expiry_mode: 'days',
  default_expiry_days: 3,
  default_low_stock_threshold: 1,
  notes: '',
  image: null,
  created_at: '2026-07-01T00:00:00Z',
  updated_at: '2026-07-01T00:00:00Z',
};

const summary: IngredientSummaryViewModel = {
  ingredient,
  inventoryItems: [],
  availableInventoryItems: [],
  alerts: [],
  quantitySummaries: [{ unit: '个', total: 2, label: '2个' }],
  hasMultipleUnits: false,
  primaryStorage: '冷藏',
  storageLocations: ['冷藏'],
  recipeReferences: [],
  latestPurchaseDate: '2026-06-25',
  latestUpdatedAt: '2026-07-01T00:00:00Z',
};

const expiredItems: DisposableExpiredInventoryItemViewModel[] = [
  {
    id: 'inventory-expired-1',
    ingredientId: 'ingredient-tomato',
    ingredientName: '番茄',
    remainingQuantity: 2,
    remainingLabel: '2个',
    unit: '个',
    purchaseDate: '2026-06-20',
    expiryDate: '2026-06-25',
    storageLocation: '冷藏',
    notes: '',
    status: 'expiring',
    createdAt: '2026-06-20T00:00:00Z',
    rowVersion: 7,
  },
  {
    id: 'inventory-expired-2',
    ingredientId: 'ingredient-tomato',
    ingredientName: '番茄',
    remainingQuantity: 1,
    remainingLabel: '1个',
    unit: '个',
    purchaseDate: '2026-06-18',
    expiryDate: '2026-06-22',
    storageLocation: '冷藏',
    notes: '',
    status: 'expiring',
    createdAt: '2026-06-18T00:00:00Z',
    rowVersion: 3,
  },
];

function createActions(
  disposeExpiredInventory: (payload: DisposeExpiredInventoryRequest) => Promise<unknown> = vi.fn(
    async () => undefined,
  ),
) {
  return {
    disposeExpiredInventory,
    actions: useHomeDashboardActions({
      showNotice: vi.fn(),
      homeExpiredDisposalSummary: summary,
      homeExpiredDisposalItems: expiredItems,
      homeRestockShoppingItem: null,
      homeRestockForm: null,
      homeRestockIngredient: null,
      homePlanDetailItem: null,
      homePlanDetailForm: { planDate: '2026-07-11', mealType: 'dinner', note: '' },
      homePlanAddFood: null,
      homePlanAddForm: { planDate: '2026-07-11', mealType: 'dinner', note: '' },
      createInventory: vi.fn(async () => undefined),
      updateShoppingDone: vi.fn(async () => undefined),
      disposeExpiredInventory,
      updateFoodPlanItem: vi.fn(async () => undefined),
      deleteFoodPlanItem: vi.fn(async () => undefined),
      createFoodPlanItem: vi.fn(async () => undefined),
      quickAddMeal: vi.fn(async () => {
        throw new Error('unused');
      }),
      closeHomeRestock: vi.fn(),
      closeHomeExpiredDisposal: vi.fn(),
      closeHomePlanDetail: vi.fn(),
      closeHomePlanAddDialog: vi.fn(),
      setIsHomePlanDetailEditing: vi.fn(),
      startRecipeCook: vi.fn(),
      openMealLogEnrichment: vi.fn(),
    }),
  };
}

describe('useHomeDashboardActions disposal payload', () => {
  it('submits versioned inventory refs using each batch rowVersion', async () => {
    const disposeExpiredInventory = vi.fn(async (_payload: DisposeExpiredInventoryRequest) => undefined);
    const { actions } = createActions(disposeExpiredInventory);
    const event = {
      preventDefault: vi.fn(),
    } as unknown as FormEvent<HTMLFormElement>;

    await actions.submitHomeExpiredDisposal(event);

    expect(event.preventDefault).toHaveBeenCalled();
    expect(disposeExpiredInventory).toHaveBeenCalledWith({
      ingredient_id: 'ingredient-tomato',
      items: [
        { inventory_item_id: 'inventory-expired-1', expected_row_version: 7 },
        { inventory_item_id: 'inventory-expired-2', expected_row_version: 3 },
      ],
    });
    const submitted = disposeExpiredInventory.mock.calls[0]?.[0];
    expect(JSON.stringify(submitted)).not.toContain('inventory_item_ids');
  });
});
