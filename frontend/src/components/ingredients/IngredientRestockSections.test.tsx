// @vitest-environment jsdom

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Ingredient } from '../../api/types';
import {
  IngredientRestockAdvancedSection,
  IngredientRestockExpirySection,
  IngredientRestockPurchaseSection,
  IngredientRestockQuantitySection,
} from './IngredientRestockSections';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const restockSectionsSourcePath = resolve(__dirname, 'IngredientRestockSections.tsx');
const ingredientsStylePath = resolve(__dirname, '../../styles/04-ingredients-workspace.css');
const staleUnitEditorClasses = [
  'ingredients-restock-unit-chip-row',
  'ingredients-restock-unit-editor',
  'ingredients-restock-unit-editor-custom',
];

let root: Root | null = null;
let container: HTMLDivElement | null = null;

const trackedIngredient: Ingredient = {
  id: 'ingredient-tomato',
  family_id: 'family-1',
  name: '番茄',
  category: '蔬菜',
  default_unit: '个',
  unit_conversions: [{ unit: '斤', ratio_to_default: 4 }],
  default_storage: '冷藏',
  default_expiry_mode: 'days',
  default_expiry_days: 3,
  default_low_stock_threshold: 1,
  notes: '',
  image: null,
  created_at: '2026-07-01T00:00:00Z',
  updated_at: '2026-07-01T00:00:00Z',
};

const presenceOnlyIngredient: Ingredient = {
  ...trackedIngredient,
  id: 'ingredient-salt',
  name: '盐',
  quantity_tracking_mode: 'not_track_quantity',
};

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

function render(element: ReactElement) {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  act(() => root?.render(element));
  return container;
}

describe('IngredientRestockSections', () => {
  it('uses the shared quantity unit field without stale unit editor styles', () => {
    const componentSource = readFileSync(restockSectionsSourcePath, 'utf8');
    const styleSource = readFileSync(ingredientsStylePath, 'utf8');

    expect(componentSource).toContain('QuantityUnitField');
    expect(componentSource).toContain('ingredients-restock-quantity-field');
    expect(componentSource).toContain('ingredients-restock-unit-card');
    expect(styleSource).toContain('.ingredients-restock-unit-card');

    for (const className of staleUnitEditorClasses) {
      expect(componentSource).not.toContain(className);
      expect(styleSource).not.toContain(className);
    }
  });

  it('shows presence-only quantity copy without enabling numeric entry', () => {
    const view = render(
      <IngredientRestockQuantitySection
        ingredient={presenceOnlyIngredient}
        quantity="1"
        unit="袋"
        unitOptions={[{ value: '袋', label: '袋' }]}
        selectedUnit={null}
        normalizedQuantity={null}
        onQuantityChange={vi.fn()}
        onUnitChange={vi.fn()}
      />,
    );

    expect(view.textContent).toContain('这个食材只记录是否有库存，不填写具体数量。');
    expect(view.querySelector<HTMLInputElement>('input[type="number"]')?.disabled).toBe(true);
  });

  it('emits purchase preset changes', () => {
    const onChange = vi.fn();
    const view = render(
      <IngredientRestockPurchaseSection purchaseDate="2026-07-07" purchaseDatePreset="today" onChange={onChange} />,
    );

    act(() => {
      Array.from(view.querySelectorAll('button')).find((button) => button.textContent === '昨天')?.click();
    });

    expect(onChange).toHaveBeenCalledWith({ purchaseDatePreset: 'yesterday' });
  });

  it('renders expiry day controls and emits day changes', () => {
    const onChange = vi.fn();
    const view = render(
      <IngredientRestockExpirySection
        expiryInputMode="days"
        expiryDays="3"
        expiryDate="2026-07-10"
        purchaseDate="2026-07-07"
        defaultExpiryDays={3}
        expiryDaysValue={3}
        onChange={onChange}
      />,
    );

    expect(view.textContent).toContain('预计到期日');
    act(() => {
      const input = view.querySelector<HTMLInputElement>('input[type="range"]');
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      setter?.call(input, '7');
      input?.dispatchEvent(new Event('input', { bubbles: true }));
      input?.dispatchEvent(new Event('change', { bubbles: true }));
    });

    expect(onChange).toHaveBeenCalledWith({ expiryDays: '7', expiryDate: '2026-07-14' });
  });

  it('keeps advanced status and notes callbacks separate', () => {
    const onChange = vi.fn();
    const view = render(
      <IngredientRestockAdvancedSection
        open
        status="fresh"
        notes=""
        onOpenChange={vi.fn()}
        onChange={onChange}
      />,
    );

    const textarea = view.querySelector<HTMLTextAreaElement>('textarea');
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
      setter?.call(textarea, '冷藏第二层');
      textarea?.dispatchEvent(new Event('input', { bubbles: true }));
    });

    expect(onChange).toHaveBeenCalledWith({ notes: '冷藏第二层' });
  });
});
