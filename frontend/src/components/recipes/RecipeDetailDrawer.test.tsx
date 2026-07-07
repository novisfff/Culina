// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RecipeDetailDrawer } from './RecipeDetailDrawer';

vi.mock('./RecipeDetailView', () => ({
  RecipeDetailView: () => <div data-testid="recipe-detail-view">详情内容</div>,
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

function renderDrawer() {
  const onClose = vi.fn();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  act(() => {
    root?.render(
      <RecipeDetailDrawer
        selectedCard={{
          recipe: {
            title: '番茄炒蛋',
            prep_minutes: 12,
            servings: 2,
          },
          availabilityLabel: '食材已备齐',
        } as any}
        selectedReadyCount={0}
        selectedIngredientCount={0}
        selectedShortageCount={0}
        isSelectedFavorite={false}
        selectedRecentCookLog={null}
        selectedRecipePlanItems={[]}
        onClose={onClose}
        onCook={vi.fn()}
        onPlan={vi.fn()}
        onShopping={vi.fn()}
        onToggleFavorite={vi.fn()}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
      />,
    );
  });
  return { onClose, view: container };
}

describe('RecipeDetailDrawer', () => {
  it('uses the shared workspace overlay frame and closes from overlay controls', () => {
    const { onClose, view } = renderDrawer();

    expect(view.querySelector('.workspace-overlay-root.recipe-workspace-overlay-root')).not.toBeNull();
    expect(view.querySelector('.recipe-detail-drawer')).not.toBeNull();
    expect(view.textContent).toContain('番茄炒蛋');
    expect(view.textContent).toContain('详情内容');

    act(() => view.querySelector<HTMLDivElement>('.workspace-overlay-backdrop')?.click());
    act(() => view.querySelector<HTMLButtonElement>('.workspace-overlay-close')?.click());

    expect(onClose).toHaveBeenCalledTimes(2);
  });
});
