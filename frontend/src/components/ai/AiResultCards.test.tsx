import React, { act } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import type { AiResultCard } from '../../api/types';
import { ResultCard, targetForAiEntity } from './AiResultCards';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

async function renderCard(
  card: AiResultCard,
  onAddToPlan?: Parameters<typeof ResultCard>[0]['onAddToPlan'],
  onInventoryAction?: Parameters<typeof ResultCard>[0]['onInventoryAction'],
  onPromptAction?: (prompt: string) => void,
  onNavigate?: Parameters<typeof ResultCard>[0]['onNavigate'],
) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      <ResultCard
        card={card}
        onAddToPlan={onAddToPlan}
        onInventoryAction={onInventoryAction}
        onPromptAction={onPromptAction}
        onNavigate={onNavigate}
      />,
    );
  });
  return container;
}

function countText(value: string, target: string) {
  return value.split(target).length - 1;
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
            sourceType: 'ingredient',
            ingredientId: 'ingredient-tomato',
            foodId: null,
            inventoryItemId: 'inventory-tomato',
            name: '番茄',
            image: null,
            quantity: '3',
            unit: '个',
            quantityTrackingMode: 'track_quantity',
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
    const fallbackImage = view.querySelector<HTMLImageElement>('img.ai-query-card-image');
    expect(fallbackImage?.getAttribute('src')).toBe('/assets/ai-food-ingredient-placeholder.png');
    expect(fallbackImage?.getAttribute('data-state')).toBeNull();
    expect(view.querySelector('.ai-query-card-image .media-placeholder')).toBeNull();
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
            sourceType: 'ingredient',
            ingredientId: 'ingredient-tomato',
            foodId: null,
            inventoryItemId: 'inventory-tomato',
            name: '番茄',
            quantity: '2',
            unit: '个',
            quantityTrackingMode: 'track_quantity',
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

  it('allows depleted ingredient restock without exposing ingredient actions for Food rows', async () => {
    const actions: string[] = [];
    const view = await renderCard({
      id: 'depleted-inventory-card',
      type: 'inventory_summary',
      title: '低库存提醒',
      data: {
        queryFocus: 'low_stock',
        availableCount: 0,
        expiringCount: 0,
        expiredCount: 0,
        lowStockCount: 1,
        foodStockCount: 1,
        items: [
          {
            id: 'ingredient:ingredient-onion',
            sourceType: 'ingredient',
            ingredientId: 'ingredient-onion',
            foodId: null,
            inventoryItemId: null,
            name: '洋葱',
            quantity: '0',
            unit: '个',
            quantityTrackingMode: 'track_quantity',
            status: 'out_of_stock',
            displayStatus: 'low_stock',
            suggestedAction: 'restock',
          },
          {
            id: 'food:food-yogurt',
            sourceType: 'food',
            ingredientId: null,
            foodId: 'food-yogurt',
            inventoryItemId: null,
            name: '蓝莓酸奶',
            quantity: '1盒',
            unit: '盒',
            quantityTrackingMode: 'track_quantity',
            status: 'food_stock',
            displayStatus: 'expiring',
            suggestedAction: 'consume',
          },
        ],
      },
    }, undefined, (item, action) => actions.push(`${item.id}:${action}`));

    const buttons = Array.from(view.querySelectorAll<HTMLButtonElement>('.ai-query-inventory-actions button'));
    expect(buttons.map((button) => button.textContent)).toEqual(['补货']);
    await act(async () => buttons[0]?.click());
    expect(actions).toEqual(['ingredient:ingredient-onion:restock']);
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
          sourceType: 'ingredient',
          ingredientId: 'ingredient-tomato',
          foodId: null,
          inventoryItemId: 'inventory-tomato',
          name: '番茄',
          quantity: '2',
          unit: '个',
          quantityTrackingMode: 'track_quantity',
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

  it('renders structured clarification question and candidates', async () => {
    const view = await renderCard({
      id: 'clarification-card',
      type: 'clarification_request',
      title: '还需要你确认一下',
      data: {
        question: '你要修改哪一条晚餐计划？',
        questionType: 'meal_plan_disambiguation',
        missingFields: ['目标计划'],
        candidates: [
          {
            id: 'plan-1',
            label: '2026-06-15 晚餐 · 番茄炒蛋',
            summary: '创建人：妈妈',
            updatedAt: '2026-06-15T09:00:00Z',
          },
        ],
        allowFreeText: true,
      },
    } as unknown as Parameters<typeof renderCard>[0]);

    expect(view.textContent).toContain('你要修改哪一条晚餐计划？');
    expect(view.textContent).toContain('目标计划');
    expect(view.textContent).toContain('2026-06-15 晚餐 · 番茄炒蛋');
    expect(view.textContent).toContain('创建人：妈妈');
    expect(view.querySelector('.ai-clarification-options')?.getAttribute('aria-label')).toBe('可选项');
    expect(view.textContent).toContain('选项 1');
    expect(view.textContent).toContain('直接回复选项编号、名称或补充信息即可。');
  });

  it('renders approval success results with affected entities and destination hint', async () => {
    const view = await renderCard({
      id: 'operation-result-card',
      type: 'operation_result',
      title: '已修改餐食计划',
      data: {
        actionSummary: '已修改餐食计划',
        entityCount: 1,
        entityCountLabel: '1 条计划',
        workspaceLabel: '菜单计划',
        workspaceHint: '可前往菜单计划查看',
        entities: [
          {
            id: 'plan-1',
            label: '2026-06-18 MealType.DINNER',
            operation: 'create',
            operationLabel: 'create',
            updatedAt: '2026-06-15T09:00:00Z',
          },
        ],
      },
    });

    expect(view.textContent).toContain('已按确认执行');
    expect(countText(view.textContent ?? '', '已修改餐食计划')).toBe(1);
    expect(view.textContent).toContain('影响 1 条计划');
    expect(view.textContent).toContain('查看位置');
    expect(view.textContent).toContain('菜单计划');
    expect(view.textContent).toContain('2026-06-18 晚餐');
    expect(view.textContent).toContain('新增');
    expect(view.textContent).not.toContain('MealType.DINNER');
    expect(view.querySelector('.ai-query-reason')).toBeNull();
    expect(view.querySelector('.ai-operation-result-footer')).not.toBeNull();
  });

  it('renders inventory intake results as a meaningful completed checklist', async () => {
    const view = await renderCard({
      id: 'inventory-intake-result-card',
      type: 'operation_result',
      title: '已入库',
      data: {
        actionSummary: '已入库',
        entityCount: 2,
        entityCountLabel: '2 项入库',
        workspaceLabel: '库存',
        workspaceHint: '可前往库存查看',
        entities: [
          {
            id: 'intake-milk',
            label: '牛奶 · 1 袋 · 冷藏',
            operation: 'stock_only',
            operationLabel: '直接入库',
          },
          {
            id: 'intake-eggs',
            label: '鸡蛋 · 12 个 · 冷藏',
            operation: 'stock_and_fulfill',
            operationLabel: '入库并完成采购项',
          },
        ],
      },
    });

    expect(view.textContent).toContain('牛奶 · 1 袋 · 冷藏');
    expect(view.textContent).toContain('直接入库');
    expect(view.textContent).toContain('鸡蛋 · 12 个 · 冷藏');
    expect(view.textContent).toContain('入库并完成采购项');
    const states = view.querySelectorAll('.ai-operation-result-state');
    expect(states).toHaveLength(2);
    expect(Array.from(states).every((state) => state.getAttribute('aria-label') === '已完成')).toBe(true);
  });

  it('localizes legacy operation result entity fallback labels', async () => {
    const view = await renderCard({
      id: 'inventory-operation-result-card',
      type: 'operation_result',
      title: '已处理库存',
      data: {
        entityCount: 1,
        entityCountLabel: '1 项库存变更',
        workspaceLabel: '库存页',
        workspaceHint: '可前往库存页查看',
        entities: [
          {
            id: 'inventory-1',
            label: 'inventory_operation',
            operation: 'restock',
            operationLabel: '补货',
          },
        ],
      },
    });

    expect(view.textContent).toContain('库存处理');
    expect(view.textContent).toContain('补货');
    expect(view.textContent).not.toContain('inventory_operation');
  });

  it('renders recipe shortages and sends a normal shopping prompt', async () => {
    const prompts: string[] = [];
    const view = await renderCard({
      id: 'recipe-shortage:recipe-1',
      type: 'recipe_shortage',
      title: '番茄香菜汤缺少 2 项食材',
      data: {
        recipeId: 'recipe-1',
        recipeTitle: '番茄香菜汤',
        actionPrompt: '把缺少的食材加入购物清单',
        shortages: [
          {
            ingredientId: 'ingredient-tomato',
            ingredientName: '番茄',
            shortageType: 'quantity',
            quantity: '2',
            unit: '个',
          },
          {
            ingredientId: 'ingredient-herb',
            ingredientName: '香菜',
            shortageType: 'presence',
          },
        ],
      },
    }, undefined, undefined, (prompt) => prompts.push(prompt));

    expect(view.textContent).toContain('番茄香菜汤');
    expect(view.textContent).toContain('番茄');
    expect(view.textContent).toContain('缺少 2个');
    expect(view.textContent).toContain('香菜');
    expect(view.textContent).toContain('需要补充');
    const button = view.querySelector<HTMLButtonElement>('button');
    expect(button?.textContent).toContain('加入购物清单');
    await act(async () => button?.click());
    expect(prompts).toEqual(['把缺少的食材加入购物清单']);
  });

  it('maps AI entities without setting a tab directly', () => {
    expect(targetForAiEntity({ type: 'meal_log', id: 'meal-1' })).toEqual({
      workspace: 'eat',
      view: 'history',
      mealLogId: 'meal-1',
    });
    expect(targetForAiEntity({ type: 'food', id: 'food-1' })).toEqual({
      workspace: 'eat',
      view: 'food',
      foodId: 'food-1',
    });
    expect(targetForAiEntity({ type: 'recipe', id: 'recipe-1' })).toEqual({
      workspace: 'eat',
      view: 'recipe',
      recipeId: 'recipe-1',
    });
    expect(targetForAiEntity({ type: 'meal_plan', id: 'plan-1' })).toEqual({
      workspace: 'eat',
      view: 'plan',
      foodPlanItemId: 'plan-1',
    });
  });

  it('navigates recommendation entities via semantic targets', async () => {
    const targets: unknown[] = [];
    const view = await renderCard({
      id: 'recommendation-nav-card',
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
            reason: '适合今天。',
            evidence: [],
          },
        ],
        contextSummary: { inventoryCount: 1, expiringCount: 0, recentMealCount: 0, recipeCount: 1 },
      },
    }, undefined, undefined, undefined, (target) => targets.push(target));

    const openButton = Array.from(view.querySelectorAll('button')).find((button) => button.textContent?.includes('番茄鸡蛋面'));
    expect(openButton).toBeDefined();
    await act(async () => openButton?.click());
    expect(targets).toEqual([
      { workspace: 'eat', view: 'recipe', recipeId: 'recipe-1' },
    ]);
  });
});
