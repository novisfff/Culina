import React, { act } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import type { AiResultCard } from '../../api/types';
import { ResultCard } from './AiResultCards';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

async function renderCard(
  card: AiResultCard,
  onAddToPlan?: Parameters<typeof ResultCard>[0]['onAddToPlan'],
  onInventoryAction?: Parameters<typeof ResultCard>[0]['onInventoryAction'],
) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(<ResultCard card={card} onAddToPlan={onAddToPlan} onInventoryAction={onInventoryAction} />);
  });
  return container;
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

describe('AI query result cards', () => {
  it('renders inventory entities with image, quantity, expiry and status', async () => {
    const view = await renderCard({
      id: 'inventory-card',
      type: 'inventory_summary',
      title: '库存概览',
      data: {
        queryFocus: 'overview',
        availableCount: 4,
        expiringCount: 1,
        lowStockCount: 1,
        items: [
          {
            id: 'inventory-tomato',
            ingredientId: 'ingredient-tomato',
            name: '番茄',
            image: null,
            quantity: '3',
            unit: '个',
            status: 'fresh',
            displayStatus: 'expiring',
            expiryDate: '2026-06-16',
            daysUntilExpiry: 2,
          },
        ],
      },
    });

    expect(view.querySelector('.ai-query-item-title strong')?.textContent).toBe('番茄');
    expect(view.textContent).toContain('3个');
    expect(view.textContent).toContain('保质期至 2026-06-16');
    expect(view.textContent).toContain('2 天后到期');
    expect(view.querySelector<HTMLImageElement>('.ai-query-card-image')?.src).toContain('ai-food-ingredient-placeholder.png');
  });

  it('renders only the suggested inventory action and the persisted operation result', async () => {
    const actions: string[] = [];
    const view = await renderCard({
      id: 'inventory-action-card',
      type: 'inventory_summary',
      title: '库存概览',
      data: {
        queryFocus: 'expiring',
        availableCount: 1,
        expiringCount: 0,
        lowStockCount: 0,
        items: [
          {
            id: 'inventory-tomato',
            ingredientId: 'ingredient-tomato',
            name: '番茄',
            quantity: '2',
            unit: '个',
            status: 'fresh',
            displayStatus: 'available',
            suggestedAction: 'consume',
            lastOperation: {
              action: 'consume',
              quantity: 1,
              unit: '个',
              handledAt: '2026-06-14T10:00:00Z',
            },
          },
        ],
      },
    }, undefined, (_item, action) => actions.push(action));

    expect(view.textContent).toContain('已消耗 1个');
    const buttons = Array.from(view.querySelectorAll<HTMLButtonElement>('.ai-query-inventory-actions button'));
    expect(buttons.map((button) => button.textContent)).toEqual(['消耗']);
    await act(async () => buttons[0]?.click());
    expect(actions).toEqual(['consume']);
  });

  it('does not expose processing actions for an overview query', async () => {
    const view = await renderCard({
      id: 'inventory-overview-card',
      type: 'inventory_summary',
      title: '库存概览',
      data: {
        queryFocus: 'overview',
        availableCount: 1,
        expiringCount: 1,
        lowStockCount: 0,
        items: [{
          id: 'inventory-tomato',
          ingredientId: 'ingredient-tomato',
          name: '番茄',
          quantity: '2',
          unit: '个',
          status: 'fresh',
          displayStatus: 'expiring',
          expiryDate: '2026-06-16',
        }],
      },
    }, undefined, () => undefined);

    expect(view.querySelector('.ai-query-inventory-actions')).toBeNull();
  });

  it('renders verified recommendation details and evidence', async () => {
    let selectedName = '';
    const view = await renderCard({
      id: 'recommendation-card',
      type: 'today_recommendation',
      title: '今日吃什么',
      data: {
        recommendations: [
          {
            entityType: 'recipe',
            entityId: 'recipe-1',
            foodId: 'food-1',
            recipeId: 'recipe-1',
            name: '番茄鸡蛋面',
            image: null,
            prepMinutes: 20,
            servings: 2,
            difficulty: 'easy',
            reason: '优先消耗临期番茄。',
            evidence: [{ type: 'inventory', id: 'inventory-1', label: '番茄', detail: '3个' }],
          },
        ],
        contextSummary: {
          inventoryCount: 4,
          expiringCount: 1,
          recentMealCount: 2,
          recipeCount: 5,
        },
      },
    }, (item) => {
      selectedName = item.name;
    });

    expect(view.textContent).toContain('番茄鸡蛋面');
    expect(view.textContent).toContain('20 分钟 · 2 人份 · easy');
    expect(view.textContent).toContain('优先消耗临期番茄。');
    expect(view.textContent).toContain('番茄 · 3个');
    const addButton = Array.from(view.querySelectorAll('button')).find((button) => button.textContent === '加入菜单计划');
    expect(addButton).toBeDefined();
    await act(async () => addButton?.click());
    expect(selectedName).toBe('番茄鸡蛋面');
    expect(view.querySelector('.ai-query-recommendation-list')).not.toBeNull();
  });

  it('shows a useful empty state instead of an empty shell', async () => {
    const view = await renderCard({
      id: 'empty-inventory-card',
      type: 'inventory_summary',
      title: '库存概览',
      data: { queryFocus: 'overview', availableCount: 0, expiringCount: 0, lowStockCount: 0, items: [] },
    });

    expect(view.textContent).toContain('当前没有可展示的库存');
    expect(view.querySelector('.ai-query-empty')).not.toBeNull();
  });

  it('renders the persisted menu selection instead of another add button', async () => {
    const view = await renderCard({
      id: 'selected-recommendation-card',
      type: 'today_recommendation',
      title: '明晚吃什么',
      data: {
        recommendations: [
          {
            entityType: 'food',
            entityId: 'food-1',
            foodId: 'food-1',
            name: '番茄炒蛋',
            image: null,
            reason: '适合明晚。',
            evidence: [],
            planSelection: {
              foodPlanItemId: 'plan-1',
              foodId: 'food-1',
              name: '番茄炒蛋',
              planDate: '2026-06-15',
              mealType: 'dinner',
              selectedAt: '2026-06-14T10:00:00Z',
            },
          },
        ],
        contextSummary: { inventoryCount: 1, expiringCount: 0, recentMealCount: 0, recipeCount: 0 },
      },
    });

    expect(view.textContent).toContain('已加入菜单');
    expect(view.textContent).toContain('2026-06-15 · 晚餐');
    expect(Array.from(view.querySelectorAll('button')).some((button) => button.textContent === '加入菜单计划')).toBe(false);
  });
});
