import React, { act } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { aiApi } from '../../api/aiApi';
import { ApiError } from '../../api/request';
import type { AiOperationResultProjection, AiOperationRevertResponse, AiResultCard } from '../../api/types';
import { operationResultProjection, operationResultViewModel } from './AiResultCardModel';
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
  onResultCard?: Parameters<typeof ResultCard>[0]['onResultCard'],
) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { mutations: { retry: false }, queries: { retry: false } } })}>
        <ResultCard
          card={card}
          conversationId="conversation-1"
          onAddToPlan={onAddToPlan}
          onInventoryAction={onInventoryAction}
          onPromptAction={onPromptAction}
          onNavigate={onNavigate}
          onResultCard={onResultCard}
        />
      </QueryClientProvider>,
    );
  });
  return container;
}

function operationProjection(overrides: Partial<AiOperationResultProjection> = {}): AiOperationResultProjection {
  return {
    draft_id: 'draft-1',
    operation_id: 'operation-1',
    result_status: 'completed',
    execution_mode: 'policy_auto',
    operation_status: 'completed',
    execution_explanation: '已自动收藏番茄炒蛋。',
    revert_availability: 'available',
    revertible_until: '2026-08-24T15:42:00+08:00',
    revert_blocked_code: null,
    server_now: '2026-08-24T15:00:00+08:00',
    entities: [{ id: 'food-1', label: '食物', operation: 'food', operationLabel: '收藏' }],
    cache_scopes: ['food', 'ai_conversation'],
    ...overrides,
  };
}

function operationCard(overrides: Partial<AiOperationResultProjection> = {}): AiResultCard {
  return {
    id: 'operation-card-1',
    type: 'operation_result',
    title: '已收藏番茄炒蛋',
    data: operationProjection(overrides) as unknown as AiResultCard['data'],
  };
}

function revertedResponse(): AiOperationRevertResponse {
  const projection = operationProjection({
    result_status: 'reverted',
    operation_status: 'reverted',
    execution_explanation: '已撤销自动收藏。',
    revert_availability: 'reverted',
    server_now: '2026-08-24T15:01:00+08:00',
  });
  return {
    projection,
    result_card: { ...operationCard(), title: '收藏已撤销', data: projection as unknown as AiResultCard['data'] },
    cache_scopes: projection.cache_scopes,
    server_now: projection.server_now,
    replayed: false,
  };
}

function countText(value: string, target: string) {
  return value.split(target).length - 1;
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.useRealTimers();
  vi.restoreAllMocks();
  Object.defineProperty(window.navigator, 'onLine', { configurable: true, value: true });
});

describe('AI operation result state', () => {
  it.each([
    ['manual_approval', 'completed', '已按你的确认执行'],
    ['policy_auto', 'completed', '已自动执行'],
    ['policy_no_change', 'no_change', '已是目标状态'],
    ['policy_auto', 'failed', '未完成操作'],
    ['policy_auto', 'reverted', '已撤销'],
  ] as const)('renders the controlled eyebrow for %s/%s', async (executionMode, resultStatus, eyebrow) => {
    vi.setSystemTime(new Date('2026-08-24T15:00:00+08:00'));
    const view = await renderCard(operationCard({
      execution_mode: executionMode,
      result_status: resultStatus,
      operation_status: resultStatus === 'no_change' ? null : resultStatus,
      revert_availability: resultStatus === 'reverted' ? 'reverted' : resultStatus === 'completed' ? 'available' : 'unsupported',
    }));
    expect(view.textContent).toContain(eyebrow);
  });

  it('validates projection fields before controlled rendering', () => {
    expect(operationResultProjection(operationCard())).toEqual(operationProjection());
    expect(operationResultProjection({ ...operationCard(), data: { ...operationProjection(), cache_scopes: ['not-a-scope'] } as unknown as AiResultCard['data'] })).toBeNull();
    expect(operationResultProjection({ ...operationCard(), type: 'inventory_summary' })).toBeNull();
  });

  it.each([
    ['missing deadline', { revertible_until: null }],
    ['invalid deadline', { revertible_until: 'not-a-date' }],
    ['invalid server clock', { server_now: 'not-a-date' }],
    ['deadline before server clock', {
      server_now: '2026-08-24T15:42:00+08:00',
      revertible_until: '2026-08-24T15:41:59+08:00',
    }],
  ] as const)('fails closed for an available projection with %s', async (_label, overrides) => {
    const card = operationCard(overrides as Partial<AiOperationResultProjection>);
    const view = await renderCard(card);

    expect(operationResultProjection(card)).toBeNull();
    expect(view.textContent).toContain('结果详情暂不可用，请刷新后重试。');
    expect(Array.from(view.querySelectorAll<HTMLButtonElement>('button')).some((button) => !button.disabled && button.textContent === '撤销')).toBe(false);
  });

  it('fails closed when the effective clock is not finite', () => {
    expect(operationResultViewModel(operationProjection(), Number.NaN)).toMatchObject({
      canRevert: false,
      statusText: '撤销状态暂不可用，请刷新后重试',
    });
  });

  it('keeps the inclusive deadline available and expires immediately just after it', () => {
    const projection = operationProjection();
    expect(operationResultViewModel(projection, Date.parse('2026-08-24T15:42:00+08:00'))).toMatchObject({
      canRevert: true,
      deadlineText: '可撤销至 15:42',
    });
    expect(operationResultViewModel(projection, Date.parse('2026-08-24T15:42:00.001+08:00'))).toMatchObject({
      canRevert: false,
      statusText: '撤销时间已过，可前往页面修改',
    });
  });

  it('does not style blocked or unsupported results as success', () => {
    expect(operationResultViewModel(operationProjection({
      revert_availability: 'blocked',
      revert_blocked_code: 'revert_target_changed',
    }), Date.parse('2026-08-24T15:00:00+08:00')).tone).toBe('danger');
    expect(operationResultViewModel(operationProjection({
      revert_availability: 'unsupported',
      revertible_until: null,
    }), Date.parse('2026-08-24T15:00:00+08:00')).tone).toBe('neutral');
  });

  it.each([
    [{ result_status: 'no_change', execution_mode: 'policy_no_change', execution_explanation: '相关内容已经是你要求的状态。' }, '相关内容已经是你要求的状态。'],
    [{ result_status: 'failed', execution_explanation: '数据库暂时不可用。' }, '本次操作未完成'],
    [{ revert_availability: 'expired' }, '撤销时间已过，可前往页面修改'],
    [{ revert_availability: 'unsupported' }, '此操作需要前往页面修正'],
    [{ revert_availability: 'blocked', revert_blocked_code: 'revert_target_changed' }, '相关内容后来被修改，无法安全撤销'],
    [{ revert_availability: 'blocked', revert_blocked_code: 'revert_dependency_exists' }, '该内容已被后续操作使用'],
    [{ result_status: 'reverted', operation_status: 'reverted', revert_availability: 'reverted' }, '操作已撤销'],
  ] as const)('renders controlled terminal copy', async (overrides, copy) => {
    vi.setSystemTime(new Date('2026-08-24T15:00:00+08:00'));
    const view = await renderCard(operationCard(overrides as Partial<AiOperationResultProjection>));
    expect(view.textContent).toContain(copy);
    expect(Array.from(view.querySelectorAll('button')).some((button) => button.textContent === '撤销')).toBe(false);
  });

  it('reverts directly without a dialog or optimistic success and politely announces the HTTP replacement', async () => {
    vi.setSystemTime(new Date('2026-08-24T15:00:00+08:00'));
    let resolveRequest: ((value: AiOperationRevertResponse) => void) | null = null;
    vi.spyOn(aiApi, 'revertAiOperation').mockReturnValue(new Promise((resolve) => { resolveRequest = resolve; }));
    const user = userEvent.setup();
    const view = await renderCard(operationCard());
    const button = Array.from(view.querySelectorAll<HTMLButtonElement>('button')).find((item) => item.textContent === '撤销') as HTMLButtonElement;

    await user.click(button);
    expect(view.querySelector('[role="dialog"]')).toBeNull();
    expect(view.textContent).toContain('已自动执行');
    expect(button.disabled).toBe(true);
    expect(document.activeElement).toBe(button);
    expect(view.textContent).not.toContain('已撤销');
    await act(async () => { resolveRequest?.(revertedResponse()); });

    expect(view.textContent).toContain('已撤销');
    expect(document.activeElement).toBe(button);
    expect(button.isConnected).toBe(true);
    expect(button.disabled).toBe(true);
    expect(button.textContent).toBe('已撤销');
    const liveRegion = view.querySelector('[role="status"]');
    expect(liveRegion?.getAttribute('aria-live')).toBe('polite');
    expect(liveRegion?.textContent).toContain('操作已撤销');
  });

  it('disables offline revert without queuing a request', async () => {
    vi.setSystemTime(new Date('2026-08-24T15:00:00+08:00'));
    Object.defineProperty(window.navigator, 'onLine', { configurable: true, value: false });
    const apiSpy = vi.spyOn(aiApi, 'revertAiOperation');
    const view = await renderCard(operationCard());

    const button = Array.from(view.querySelectorAll<HTMLButtonElement>('button')).find((item) => item.textContent === '撤销');
    expect(button?.disabled).toBe(true);
    expect(view.textContent).toContain('联网后可重试撤销');
    expect(apiSpy).not.toHaveBeenCalled();
  });

  it('replaces an available card with the persisted blocked card from a permanent conflict', async () => {
    const blockedProjection = operationProjection({
      execution_explanation: '相关内容后来被修改，无法安全撤销。',
      revert_availability: 'blocked',
      revert_blocked_code: 'revert_target_changed',
      server_now: '2026-08-24T15:01:00+08:00',
    });
    const blockedResponse: AiOperationRevertResponse = {
      projection: blockedProjection,
      result_card: { ...operationCard(), data: blockedProjection as unknown as AiResultCard['data'] },
      cache_scopes: blockedProjection.cache_scopes,
      server_now: blockedProjection.server_now,
      replayed: false,
    };
    vi.spyOn(aiApi, 'revertAiOperation').mockRejectedValue(new ApiError({
      status: 409,
      detail: '相关内容后来被修改，无法安全撤销',
      path: '/api/ai/operations/operation-1/revert',
      payload: { detail: { ...blockedResponse, code: 'revert_target_changed', message: '相关内容后来被修改，无法安全撤销' } },
    }));
    const view = await renderCard(operationCard());
    const revertButton = Array.from(view.querySelectorAll<HTMLButtonElement>('button')).find((button) => button.textContent === '撤销') as HTMLButtonElement;
    revertButton.focus();

    await act(async () => {
      revertButton.click();
    });

    expect(view.textContent).toContain('相关内容后来被修改，无法安全撤销');
    expect(document.activeElement).toBe(revertButton);
    expect(revertButton.isConnected).toBe(true);
    expect(revertButton.disabled).toBe(true);
    expect(revertButton.textContent).toBe('无法撤销');
    expect(view.querySelector('[role="status"]')?.textContent).toBe('相关内容后来被修改，无法安全撤销');
  });

  it('keeps the server-projected available card retryable after a temporary failure', async () => {
    vi.spyOn(aiApi, 'revertAiOperation').mockRejectedValue(new TypeError('network unavailable'));
    const view = await renderCard(operationCard());

    await act(async () => {
      Array.from(view.querySelectorAll<HTMLButtonElement>('button')).find((button) => button.textContent === '撤销')?.click();
    });

    const retryButton = Array.from(view.querySelectorAll<HTMLButtonElement>('button')).find((button) => button.textContent === '撤销');
    expect(retryButton?.disabled).toBe(false);
    expect(view.querySelector('[role="status"]')?.textContent).toBe('撤销失败，请重试');
    expect(view.textContent).toContain('已自动执行');
  });

  it('updates the server-aligned clock once per minute without resetting a delayed refresh window', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-24T10:30:00+08:00'));
    const view = await renderCard(operationCard({
      server_now: '2026-08-24T10:30:00+08:00',
      revertible_until: '2026-08-24T11:00:00+08:00',
    }));
    expect(view.textContent).toContain('可撤销至 11:00');
    expect(Array.from(view.querySelectorAll('button')).some((button) => button.textContent === '撤销')).toBe(true);

    await act(async () => { await vi.advanceTimersByTimeAsync(30 * 60_000); });
    expect(Array.from(view.querySelectorAll('button')).some((button) => button.textContent === '撤销')).toBe(true);
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(Array.from(view.querySelectorAll('button')).some((button) => button.textContent === '撤销')).toBe(false);
  });

  it('expires at the first millisecond after a non-minute-aligned deadline', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-24T10:30:30.250+08:00'));
    const view = await renderCard(operationCard({
      server_now: '2026-08-24T10:30:30.250+08:00',
      revertible_until: '2026-08-24T11:00:00.000+08:00',
    }));

    await act(async () => { await vi.advanceTimersByTimeAsync(29 * 60_000 + 29_750); });
    expect(Array.from(view.querySelectorAll('button')).some((button) => button.textContent === '撤销')).toBe(true);

    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(Array.from(view.querySelectorAll('button')).some((button) => button.textContent === '撤销')).toBe(false);
    expect(view.textContent).toContain('撤销时间已过，可前往页面修改');
  });

  it('navigates to details and automatic execution settings with keyboard-operable buttons', async () => {
    vi.setSystemTime(new Date('2026-08-24T15:00:00+08:00'));
    const targets: unknown[] = [];
    const view = await renderCard(operationCard(), undefined, undefined, undefined, (target) => targets.push(target));
    const user = userEvent.setup();
    const settings = Array.from(view.querySelectorAll<HTMLButtonElement>('button')).find((button) => button.textContent === '管理自动执行设置') as HTMLButtonElement;
    settings.focus();
    await user.keyboard('{Enter}');
    expect(targets).toContainEqual({ workspace: 'ai', view: 'autoExecution' });
    expect(document.activeElement).toBe(settings);
    await user.click(Array.from(view.querySelectorAll<HTMLButtonElement>('button')).find((button) => button.textContent === '查看详情') as HTMLButtonElement);
    expect(targets).toContainEqual({ workspace: 'eat', view: 'food', foodId: 'food-1' });
  });
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
        ...operationProjection({
          execution_mode: 'manual_approval',
          execution_explanation: '已按你的确认修改餐食计划。',
          revert_availability: 'unsupported',
          revertible_until: null,
        }),
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

    expect(view.textContent).toContain('已按你的确认执行');
    expect(countText(view.textContent ?? '', '已修改餐食计划')).toBe(1);
    expect(view.textContent).toContain('影响 1 条计划');
    expect(view.textContent).toContain('查看位置');
    expect(view.textContent).toContain('菜单计划');
    expect(view.textContent).toContain('2026-06-18 晚餐');
    expect(view.textContent).toContain('新增');
    expect(view.textContent).not.toContain('MealType.DINNER');
    expect(view.querySelector('.ai-query-reason')?.textContent).toBe('已按你的确认修改餐食计划。');
    expect(view.querySelector('.ai-operation-result-footer')).not.toBeNull();
  });

  it('renders inventory intake results as a meaningful completed checklist', async () => {
    const view = await renderCard({
      id: 'inventory-intake-result-card',
      type: 'operation_result',
      title: '已入库',
      data: {
        ...operationProjection({
          execution_mode: 'manual_approval',
          execution_explanation: '已按你的确认完成入库。',
          revert_availability: 'unsupported',
          revertible_until: null,
        }),
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
        ...operationProjection({
          execution_mode: 'manual_approval',
          execution_explanation: '已按你的确认处理库存。',
          revert_availability: 'unsupported',
          revertible_until: null,
        }),
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
