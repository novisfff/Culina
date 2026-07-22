import React, { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import type { AiResultCard } from '../../api/types';
import { ResultCard } from './AiResultCards';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

describe('AI product loop cards', () => {
  it('does not render inventory intake candidate product-loop actions', async () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(
        <ResultCard
          card={{
            id: 'inventory-summary-1',
            type: 'inventory_summary',
            title: '库存摘要',
            data: {
              items: [],
              availableCount: 0,
              expiringCount: 0,
              expiredCount: 0,
              lowStockCount: 0,
            },
          } as unknown as AiResultCard}
        />,
      );
    });
    expect(container.textContent || '').not.toContain('按选中项准备入库');
    expect(Array.from(container.querySelectorAll('button')).some((button) => button.textContent?.includes('按选中项准备入库'))).toBe(false);
  });

  it('continues an inventory-backed meal idea into recipe drafting without fake entity ids', async () => {
    const onProductLoopPrompt = vi.fn();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(
        <ResultCard
          card={{
            id: 'meal-idea-1',
            type: 'meal_idea_proposal',
            title: '番茄清汤',
            data: {
              title: '番茄清汤',
              reason: '现有番茄库存可以组合',
              ingredientIds: ['ingredient-tomato'],
              ingredients: [
                {
                  ingredientId: 'ingredient-tomato',
                  name: '番茄',
                  quantityMode: 'track_quantity',
                  availableQuantity: '3',
                  unit: '个',
                  available: true,
                },
              ],
              preparationSummary: '番茄切块后煮出汤汁。',
            },
          } as unknown as AiResultCard}
          onProductLoopPrompt={onProductLoopPrompt}
        />,
      );
    });

    expect(container.textContent).toContain('现有番茄库存可以组合');
    const action = Array.from(container.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent?.includes('整理成菜谱'));
    expect(action?.disabled).toBe(false);
    await act(async () => action?.click());

    expect(onProductLoopPrompt).toHaveBeenCalledWith({
      message: '把这个想法整理成菜谱',
      quick_task: 'recipe_draft',
      subject: {
        source: 'meal_idea_proposal',
        ingredient_ids: ['ingredient-tomato'],
        extra: {
          mealIdea: {
            schemaVersion: 'meal_idea_subject.v1',
            title: '番茄清汤',
            ingredientIds: ['ingredient-tomato'],
            reason: '现有番茄库存可以组合',
            preparationSummary: '番茄切块后煮出汤汁。',
          },
        },
      },
    });
  });
});
