import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Food } from '../../api/types';
import type { FoodShoppingDraft } from './FoodShoppingModel';
import { FoodShoppingDialog } from './FoodShoppingDialog';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const food = {
  id: 'food-milk',
  name: '盒装牛奶',
  type: 'readyMade',
  category: '饮品',
  stock_quantity: 0,
  stock_unit: '盒',
  images: [],
} as unknown as Food;

const draft: FoodShoppingDraft = {
  foodId: food.id,
  title: food.name,
  quantity: '1',
  unit: '盒',
  reason: '补充成品库存',
};

describe('FoodShoppingDialog', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('keeps the food locked and details collapsed by default', () => {
    act(() => {
      root.render(
        <FoodShoppingDialog
          food={food}
          draft={draft}
          existingItem={null}
          onDraftChange={vi.fn()}
          onSubmit={vi.fn()}
          onClose={vi.fn()}
        />,
      );
    });

    expect(container.textContent).toContain('盒装牛奶');
    expect(container.textContent).toContain('当前库存 0盒');
    expect(container.textContent).toContain('单位：盒');
    expect(container.querySelector('[aria-label="更换采购对象"]')).toBeNull();
    expect(container.querySelector('[name="food-shopping-unit"]')).toBeNull();
    expect(container.querySelector('[name="food-shopping-reason"]')).toBeNull();
  });

  it('expands only the current item details for unit and reason editing', () => {
    act(() => {
      root.render(
        <FoodShoppingDialog
          food={food}
          draft={draft}
          existingItem={null}
          onDraftChange={vi.fn()}
          onSubmit={vi.fn()}
          onClose={vi.fn()}
        />,
      );
    });

    const toggle = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('展开详情'),
    );
    act(() => toggle?.click());

    expect(container.querySelector('[name="food-shopping-unit"]')).not.toBeNull();
    expect(container.querySelector('[name="food-shopping-reason"]')).not.toBeNull();
    expect(toggle?.getAttribute('aria-expanded')).toBe('true');
  });
});
