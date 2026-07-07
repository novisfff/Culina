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

  it('mobile ingredient page can present ready food stock', () => {
    const mobileSource = readFileSync(sourcePath, 'utf8');
    expect(mobileSource).toContain('mobileFoodStockItems');
    expect(mobileSource).toContain('成品速食');
    expect(mobileSource).toContain('记到今天');
    expect(mobileSource).toContain('const priorityItemCount = props.mobilePrioritySummaries.length + props.mobileFoodStockItems.length;');
    expect(mobileSource).toContain('const hasPriorityItems = priorityItemCount > 0;');
    expect(mobileSource).toContain('<h2>今天先处理 <span>{priorityItemCount} 项</span></h2>');
    expect(mobileSource).toContain('当前没有需要优先处理的食材或成品');

    const workspaceSource = readFileSync(resolve(__dirname, 'IngredientWorkspace.tsx'), 'utf8');
    expect(workspaceSource).toContain("() => unifiedInventoryItems.filter((item) => item.source_type === 'food')");
    expect(workspaceSource).not.toContain("() => filteredUnifiedInventoryItems.filter((item) => item.source_type === 'food')");
  });
});
