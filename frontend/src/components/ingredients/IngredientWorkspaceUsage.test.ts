import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const sourcePath = resolve(__dirname, 'IngredientWorkspace.tsx');

describe('IngredientWorkspace shared overlay usage', () => {
  it('uses the shared overlay frame for the mobile ingredient detail popover', () => {
    const source = readFileSync(sourcePath, 'utf8');

    expect(source).toContain('rootClassName="ingredient-workspace-overlay-root mobile-ingredient-detail-popover-root"');
    expect(source).toContain('backdropClassName="mobile-ingredient-detail-popover-backdrop"');
    expect(source).not.toContain(
      `className="workspace-overlay-root ingredient-workspace-overlay-root mobile-ingredient-detail-popover-root"`,
    );
    expect(source).not.toContain(
      `className="workspace-overlay-backdrop mobile-ingredient-detail-popover-backdrop"`,
    );
  });

  it('uses the shared overlay frame for the ingredient editor modal', () => {
    const source = readFileSync(sourcePath, 'utf8');

    expect(source).toContain('WorkspaceOverlayFrame');
    expect(source).toContain('rootClassName="ingredient-workspace-overlay-root"');
    expect(source).toContain('closeOnBackdrop={!isIngredientFormSubmitting}');
    expect(source).toContain('onClose={closeIngredientFormIfAllowed}');
    expect(source).not.toContain(
      `<div className="workspace-overlay-root ingredient-workspace-overlay-root">
          <div className="workspace-overlay-backdrop" onClick={goBackFromIngredientForm} />`,
    );
  });

  it('renders unified inventory source filters and food stock copy', () => {
    const panelsSource = readFileSync(resolve(__dirname, 'IngredientWorkspacePanels.tsx'), 'utf8');
    expect(panelsSource).toContain("label: '全部'");
    expect(panelsSource).toContain("label: '食材'");
    expect(panelsSource).toContain("label: '食物'");
    expect(panelsSource).toContain("label: '调料'");
    expect(panelsSource).toContain("label: '提醒'");
    expect(panelsSource).toContain("label: '临期'");
    expect(panelsSource).toContain("label: '在库'");
    expect(panelsSource).toContain("label: '待录入'");
    expect(panelsSource).toContain('ingredients-inventory-entry-chip-group');
    expect(panelsSource).toContain('ingredients-inventory-quick-chip-group');
    expect(panelsSource).toContain('inventorySummaryText');
    expect(panelsSource).toContain('减扣');

    const workspaceSource = readFileSync(sourcePath, 'utf8');
    expect(workspaceSource).toContain('api.getInventoryOverview');
    expect(workspaceSource).toContain('queryKeys.inventoryOverview');
    expect(workspaceSource).toContain('inventoryEntryFilter');
    expect(workspaceSource).toContain('handleInventoryEntryFilterChange');
    expect(workspaceSource).toContain('handleInventoryQuickFilterChange');
    expect(workspaceSource).toContain("setInventoryStorageFocus('all')");
    expect(workspaceSource).toContain("handleInventoryEntryFilterChange('all')");
    expect(workspaceSource).toContain("setInventorySourceFilter('all')");
  });

  it('mixes unified food stock cards into the ingredient grid without storage section headers', () => {
    const panelsSource = readFileSync(resolve(__dirname, 'IngredientWorkspacePanels.tsx'), 'utf8');

    expect(panelsSource).not.toContain('位置分区');
    expect(panelsSource).toContain('ingredients-inventory-mixed-grid');
    expect(panelsSource).toContain('ingredients-unified-inventory-source-badge');
  });

  it('shows pending ready food as a weak inventory card with only restock action', () => {
    const panelsSource = readFileSync(resolve(__dirname, 'IngredientWorkspacePanels.tsx'), 'utf8');
    const styleSource = readFileSync(resolve(__dirname, '../../styles/04-ingredients-workspace.css'), 'utf8');

    expect(panelsSource).toContain('isPendingFoodStockItem');
    expect(panelsSource).toContain('ingredients-unified-inventory-card-pending');
    expect(panelsSource).toContain('待补库存');
    expect(panelsSource).toContain('{!isPending ? (');
    expect(panelsSource).toContain('补库存');
    expect(panelsSource).toContain("isPending ? 'ingredient-work-card-action-button-primary' : 'ingredient-work-card-action-button-secondary'");
    expect(styleSource).toContain('.ingredients-unified-inventory-card-pending .inventory-ingredient-card-actions');
    expect(styleSource).toContain('grid-template-columns: repeat(2, minmax(0, 1fr));');
  });

  it('keeps stocked ready food cards focused on deduct and restock only', () => {
    const panelsSource = readFileSync(resolve(__dirname, 'IngredientWorkspacePanels.tsx'), 'utf8');

    expect(panelsSource).toContain('const shouldShowShoppingAction = isPending;');
    expect(panelsSource).toContain('tone="primary"');
    expect(panelsSource).toContain('onClick={props.onRecordMeal}');
    expect(panelsSource).toContain('减扣');
    expect(panelsSource).toContain('补库存');
    expect(panelsSource).toContain('{shouldShowShoppingAction ? (');
    expect(panelsSource).toContain('onClick={props.onAddShopping}');
    expect(panelsSource).toContain('加采购');
  });

  it('handles unified food-stock actions inside the ingredient workspace', () => {
    const workspaceSource = readFileSync(sourcePath, 'utf8');
    const panelsSource = readFileSync(resolve(__dirname, 'IngredientWorkspacePanels.tsx'), 'utf8');
    const appSource = readFileSync(resolve(__dirname, '../../App.tsx'), 'utf8');

    expect(panelsSource).toContain('减扣');
    expect(panelsSource).toContain('补库存');
    // Ordinary Food recording uses shared recordMeal; inventory is a separate command.
    expect(workspaceSource).not.toContain('api.quick' + 'AddMealLog');
    expect(workspaceSource).not.toContain('quick' + 'AddMeal');
    expect(workspaceSource).toContain('recordMeal');
    expect(workspaceSource).toContain('MealQuickRecordView');
    expect(workspaceSource).toContain('MealRecordResultBar');
    expect(workspaceSource).toContain('api.restockFoodStock');
    expect(workspaceSource).toContain('api.consumeFoodStock');
    expect(workspaceSource).toContain('expected_row_version: foodStockAdjustDialog.item.row_version');
    expect(workspaceSource).not.toContain('api.disposeFoodStock');
    expect(workspaceSource).toContain('step="0.1"');
    expect(workspaceSource).toContain('parseUnifiedFoodStockQuantity');
    expect(workspaceSource).not.toContain('ingredients-food-stock-storage-segments');
    expect(workspaceSource).not.toContain('storage_location: foodStockAdjustDialog.storageLocation');
    expect(workspaceSource).not.toContain('props.onOpenFoodEditor?.(foodId)');
    expect(workspaceSource).not.toContain('props.onOpenFoodQuickMeal?.(foodId)');
    expect(workspaceSource).not.toContain('成品库存先到食物页处理');
    expect(workspaceSource).not.toContain('记餐入口还在食物页');
    expect(appSource).not.toContain('onOpenFoodEditor={(foodId)');
    expect(appSource).not.toContain('onOpenFoodQuickMeal={(foodId)');
  });

  it('splits ingredient Food record from independent inventory mutation', () => {
    const workspaceSource = readFileSync(sourcePath, 'utf8');

    // Record payloads must not include stock/plan fields.
    expect(workspaceSource).not.toContain('deduct_food_stock');
    expect(workspaceSource).not.toContain('expected_food_row_version');
    expect(workspaceSource).not.toMatch(/recordMeal\([\s\S]{0,400}stock_quantity/);
    expect(workspaceSource).not.toMatch(/recordMeal\([\s\S]{0,400}stock_unit/);
    expect(workspaceSource).not.toMatch(/recordMeal\([\s\S]{0,400}food_plan_item_id/);

    // Inventory follow-up is a separate submit after record.
    expect(workspaceSource).toContain('api.consumeFoodStock');
    expect(workspaceSource).toContain('处理库存');
    // Cancelling inventory follow-up must not roll back the meal — no revert on dismiss.
    expect(workspaceSource).not.toMatch(/setInventoryFollowUp[\s\S]{0,200}revert/);
    expect(workspaceSource).not.toMatch(/onClose[\s\S]{0,120}revertMeal/);
  });

  it('carries shopping row versions through edit and restore actions', () => {
    const actionSource = readFileSync(resolve(__dirname, 'useIngredientActionState.ts'), 'utf8');
    const overlayStateSource = readFileSync(resolve(__dirname, 'useIngredientOverlayState.ts'), 'utf8');
    const hubSource = readFileSync(resolve(__dirname, 'IngredientHubPage.tsx'), 'utf8');
    const panelsSource = readFileSync(resolve(__dirname, 'IngredientWorkspacePanels.tsx'), 'utf8');

    expect(overlayStateSource).toContain('editingShoppingItemRowVersion');
    expect(actionSource).toContain('expected_row_version: args.editingShoppingItemRowVersion');
    expect(panelsSource).toContain('onRestoreShopping: (item: ShoppingListItem) => void');
    expect(hubSource).toContain('expected_row_version: item.row_version');
  });

  it('makes the food restock dialog a fuller quick-entry flow without storage editing', () => {
    const workspaceSource = readFileSync(sourcePath, 'utf8');
    const styleSource = readFileSync(resolve(__dirname, '../../styles/04-ingredients-workspace.css'), 'utf8');

    expect(workspaceSource).toContain('ingredients-food-stock-restock-section');
    expect(workspaceSource).toContain('ingredients-food-stock-restock-presets');
    expect(workspaceSource).toContain('ingredients-food-stock-restock-unit-row');
    expect(workspaceSource).toContain('setFoodStockRestockQuantity');
    expect(workspaceSource).toContain('setFoodStockRestockExpiryDays');
    expect(workspaceSource).toContain('setFoodStockRestockSource');
    expect(workspaceSource).toContain("const FOOD_STOCK_RESTOCK_QUANTITY_PRESETS = ['1', '2', '5', '10']");
    expect(workspaceSource).not.toContain("const FOOD_STOCK_RESTOCK_QUANTITY_PRESETS = ['1', '3', '6', '12']");
    expect(workspaceSource).toContain('不填到期');
    expect(workspaceSource).toContain('7天');
    expect(workspaceSource).toContain('30天');
    expect(workspaceSource).toContain('90天');
    expect(workspaceSource).toContain('超市');
    expect(workspaceSource).toContain('便利店');
    expect(workspaceSource).toContain('网购');
    expect(workspaceSource).toContain('盒马');
    expect(workspaceSource).not.toContain('山姆');
    expect(workspaceSource).toContain('purchase_source: foodStockAdjustDialog.purchaseSource || null');
    expect(workspaceSource).not.toContain('ingredients-food-stock-storage-segments');

    expect(styleSource).toContain('.ingredients-food-stock-restock-section');
    expect(styleSource).toContain('.ingredients-food-stock-restock-presets');
    expect(styleSource).toContain('.ingredients-food-stock-restock-presets button');
    expect(styleSource).toContain('.ingredients-food-stock-restock-helper');
  });

  it('loads a missing food before opening the unified food shopping overlay', () => {
    const workspaceSource = readFileSync(sourcePath, 'utf8');

    expect(workspaceSource).toContain('const [transientShoppingFood, setTransientShoppingFood] = useState<Food | null>(null)');
    expect(workspaceSource).toContain('async function handleAddFoodShopping(foodId: string)');
    expect(workspaceSource).toContain('const candidates = await api.getFoods({ q: item.title, limit: 20 })');
    expect(workspaceSource).toContain('food = candidates.find((candidate) => candidate.id === foodId) ?? null');
    expect(workspaceSource).toContain('setTransientShoppingFood(food)');
    expect(workspaceSource).toContain("openShoppingOverlay({ food, reason: '补充成品库存' })");
  });
});

describe('IngredientWorkspace navigation consumption', () => {
  it('consumes shopping and priority navigation once by requestId', () => {
    const workspaceSource = readFileSync(sourcePath, 'utf8');
    const stateSource = readFileSync(resolve(__dirname, 'useIngredientWorkspaceState.ts'), 'utf8');
    const mobileSource = readFileSync(resolve(__dirname, 'IngredientMobileView.tsx'), 'utf8');
    const panelsSource = readFileSync(resolve(__dirname, 'IngredientWorkspacePanels.tsx'), 'utf8');

    expect(stateSource).toContain('handledNavigationRequestIdRef');
    expect(stateSource).toContain("setCatalogStatusFilter('actionNeeded')");
    expect(stateSource).not.toContain("setCatalogStatusFilter('expired')");
    expect(workspaceSource).toContain('handledSideEffectNavigationRequestIdRef');
    expect(workspaceSource).toContain("openShoppingOverlay({ ingredient, reason: '库存不足' })");
    expect(workspaceSource).toContain("request.target === 'priority'");
    expect(workspaceSource).toContain("document.getElementById('mobile-ingredient-priority')");
    expect(mobileSource).toContain('id="mobile-ingredient-priority"');
    expect(panelsSource).toContain('id="ingredient-priority-list"');
    expect(workspaceSource).toContain("label: '需处理'");
    expect(workspaceSource).toContain("value: 'actionNeeded'");
  });

  it('does not keep the legacy destroy-expired overlay component wired', () => {
    const workspaceSource = readFileSync(sourcePath, 'utf8');
    const overlaysSource = readFileSync(resolve(__dirname, 'IngredientWorkspaceOverlays.tsx'), 'utf8');

    expect(workspaceSource).not.toContain("from './IngredientDestroyExpiredOverlay'");
    expect(overlaysSource).not.toContain("from './IngredientDestroyExpiredOverlay'");
    expect(overlaysSource).toContain('InventoryActionDialog');
  });
});

describe('IngredientWorkspace free-text shopping contract', () => {
  it('starts blank shopping forms as free_text and never auto-binds by title', () => {
    const formsSource = readFileSync(resolve(__dirname, 'ingredientWorkspaceForms.ts'), 'utf8');
    const actionSource = readFileSync(resolve(__dirname, 'useIngredientActionState.ts'), 'utf8');
    const submissionSource = readFileSync(resolve(__dirname, 'shoppingFormSubmission.ts'), 'utf8');
    const overlayStateSource = readFileSync(resolve(__dirname, 'useIngredientOverlayState.ts'), 'utf8');

    expect(formsSource).toContain("export type ShoppingTargetType = 'ingredient' | 'food' | 'free_text'");
    expect(formsSource).toContain("targetType: food ? 'food' : ingredient ? 'ingredient' : 'free_text'");
    expect(formsSource).toContain('resolveShoppingTargetType');
    expect(formsSource).toContain("return item.ingredient_id ? 'ingredient' : 'free_text'");
    expect(formsSource).not.toContain("const targetType = item.target_type === 'food' || item.food_id ? 'food' : 'ingredient'");

    expect(actionSource).toContain('resolveShoppingFormSubmission');
    expect(submissionSource).toContain("args.form.targetType === 'ingredient' && args.form.ingredientId");
    expect(submissionSource).toContain("args.form.targetType === 'food' && args.form.foodId");
    expect(submissionSource).not.toContain("args.ingredients.find((item) => item.name === title)");
    expect(submissionSource).toContain('ingredient_id: selectedIngredient?.id ?? null');
    expect(submissionSource).toContain('food_id: selectedFood?.id ?? null');

    expect(overlayStateSource).toContain('// Only resolve bound targets by stable IDs');
    expect(overlayStateSource).not.toContain(
      "args.ingredientOptions.find((ingredient) => ingredient.name === options.shoppingItem?.title.trim())",
    );
  });
});

describe('IngredientWorkspace atomic shopping intake cutover', () => {
  it('routes shopping-origin restock to openShoppingIntake and drops double mutation state', () => {
    const workspaceSource = readFileSync(sourcePath, 'utf8');
    const actionSource = readFileSync(resolve(__dirname, 'useIngredientActionState.ts'), 'utf8');
    const overlayStateSource = readFileSync(resolve(__dirname, 'useIngredientOverlayState.ts'), 'utf8');
    const overlaysSource = readFileSync(resolve(__dirname, 'IngredientWorkspaceOverlays.tsx'), 'utf8');
    const homeActionsSource = readFileSync(resolve(__dirname, '../../features/home/useHomeDashboardActions.ts'), 'utf8');
    const appSource = readFileSync(resolve(__dirname, '../../App.tsx'), 'utf8');

    expect(workspaceSource).not.toContain('pendingShoppingToComplete');
    expect(actionSource).not.toContain('pendingShoppingToComplete');
    expect(overlayStateSource).not.toContain('pendingShoppingToComplete');
    expect(overlaysSource).not.toContain('pendingShoppingToComplete');
    expect(homeActionsSource).not.toContain('库存已登记');
    expect(homeActionsSource).not.toContain('待买项仍未标记');
    expect(homeActionsSource).not.toMatch(/createInventory[\s\S]*updateShoppingDone/);
    expect(actionSource).not.toMatch(/await args\.createInventory[\s\S]*await args\.updateShoppingItem/);
    expect(actionSource).not.toContain('pendingShoppingToComplete');
    expect(workspaceSource).not.toMatch(/await api\.restockFoodStock[\s\S]{0,400}await props\.updateShoppingItem/);
    expect(workspaceSource).toContain('openShoppingIntake');
    expect(appSource).toContain('InventoryMaintenanceDialogs');
    expect(appSource).toContain('openShoppingIntake');
    expect(appSource).toContain('useShoppingIntakeState');
  });
});

describe('IngredientWorkspace ordinary presence restock', () => {
  it('branches presence manual submit to upsertInventoryState instead of createInventory', () => {
    const actionSource = readFileSync(resolve(__dirname, 'useIngredientActionState.ts'), 'utf8');
    const workspaceSource = readFileSync(sourcePath, 'utf8');
    const appSource = readFileSync(resolve(__dirname, '../../App.tsx'), 'utf8');

    expect(actionSource).toContain('upsertInventoryState');
    expect(actionSource).toContain("availability_level: 'sufficient'");
    expect(actionSource).toMatch(/if \(!tracksQuantity\)[\s\S]*upsertInventoryState/);
    expect(actionSource).toMatch(/else \{[\s\S]*createInventory/);
    expect(workspaceSource).toContain('upsertInventoryState: props.upsertInventoryState');
    expect(appSource).toContain('upsertInventoryStateMutation');
    expect(appSource).toContain('upsertInventoryState={(ingredientId, payload)');
  });
});
