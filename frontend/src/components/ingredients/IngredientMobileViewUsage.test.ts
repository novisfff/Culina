import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const sourcePath = resolve(__dirname, 'IngredientMobileView.tsx');

describe('IngredientMobileView shared overlay usage', () => {
  it('uses the shared overlay frame for the mobile shopping drawer', () => {
    const source = readFileSync(sourcePath, 'utf8');

    expect(source).toContain('WorkspaceOverlayFrame');
    expect(source).toContain('rootClassName="ingredient-workspace-overlay-root mobile-ingredient-shopping-drawer-root"');
    expect(source).toContain('backdropClassName="mobile-ingredient-shopping-drawer-backdrop"');
    expect(source).toContain('closeOnBackdrop={!props.isUpdatingShopping}');
    expect(source).not.toContain(
      'className="workspace-overlay-root ingredient-workspace-overlay-root mobile-ingredient-shopping-drawer-root"',
    );
    expect(source).not.toContain(
      'className="workspace-overlay-backdrop mobile-ingredient-shopping-drawer-backdrop"',
    );
  });

  it('mobile ingredient page mixes ready food stock into inventory library', () => {
    const mobileSource = readFileSync(sourcePath, 'utf8');
    const mobileCss = readFileSync(resolve(__dirname, '../../styles/07-mobile.css'), 'utf8');
    expect(mobileSource).toContain('mobileFoodStockItems');
    expect(mobileSource).toContain("type: 'food'");
    expect(mobileSource).toContain('mobile-ingredient-food-card');
    expect(mobileSource).toContain('mobile-ingredient-food-action-primary');
    expect(mobileSource).toContain('mobile-ingredient-food-action-secondary');
    expect(mobileCss).toContain('.mobile-ingredient-food-card.is-pending .mobile-ingredient-library-actions');
    expect(mobileCss).toContain('grid-template-columns: repeat(2, minmax(0, 1fr));');
    expect(mobileCss).toContain('.mobile-ingredient-food-action-primary');
    expect(mobileSource).toContain('ariaLabel="搜索库存"');
    expect(mobileSource).toContain('ariaLabel="库存筛选"');
    expect(mobileSource).toContain('MOBILE_INVENTORY_ENTRY_FILTER_OPTIONS');
    expect(mobileSource).toContain('MOBILE_INVENTORY_QUICK_FILTER_OPTIONS');
    expect(mobileSource).toContain("label: '在库'");
    expect(mobileSource).toContain("label: '待录入'");
    expect(mobileSource).toContain("label: '食材'");
    expect(mobileSource).toContain("label: '食物'");
    expect(mobileSource).toContain("label: '调料'");
    expect(mobileSource).toContain("label: '提醒'");
    expect(mobileSource).toContain("label: '临期'");
    expect(mobileSource).toContain('mobile-ingredient-inventory-status-filter');
    expect(mobileSource).toContain('mobile-ingredient-inventory-quick-filter');
    expect(mobileSource).toContain('handleMobileQuickFilterChange');
    expect(mobileSource).toContain("props.setMobileStorageFocus('all')");
    expect(mobileSource).toContain("props.setMobileInventoryEntryFilter('all')");
    expect(mobileSource).toContain('<h2>');
    expect(mobileSource).toContain('库存');
    expect(mobileSource).toContain('减扣');
    expect(mobileSource).toContain('补库存');
    expect(mobileSource).toContain('isPendingFoodStockItem(item)');
    expect(mobileSource).toContain('{!isPending ? (');
    expect(mobileSource).toContain('const shouldShowFoodShoppingAction = isPending;');
    expect(mobileSource).toContain('{shouldShowFoodShoppingAction ? (');
    expect(mobileSource).toContain('const priorityRows = props.mobilePriorityRows;');
    expect(mobileSource).toContain('const priorityItemCount = priorityRows.length;');
    expect(mobileSource).toContain('const hasPriorityItems = priorityItemCount > 0;');
    expect(mobileSource).toContain('<h2>今天先处理 <span>{priorityItemCount} 项</span></h2>');
    expect(mobileSource).toContain('data-action-group-id={group.id}');
    expect(mobileSource).toContain('buildPriorityGroupStatus(group)');
    expect(mobileSource).toContain('当前没有需要优先处理的食材');
    expect(mobileSource).not.toContain('mobile-food-stock-strip');
    expect(mobileSource).not.toContain('aria-label="成品速食库存"');

    const workspaceSource = readFileSync(resolve(__dirname, 'IngredientWorkspace.tsx'), 'utf8');
    expect(workspaceSource).toContain("() => unifiedInventoryItems.filter((item) => item.source_type === 'food')");
    expect(workspaceSource).not.toContain("() => filteredUnifiedInventoryItems.filter((item) => item.source_type === 'food')");
  });
});
