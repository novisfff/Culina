import React, { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import type { CreateFoodPlanItemPayload } from '../../api/types';
import { AiRecommendationPlanDialog } from './AiRecommendationPlanDialog';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

describe('AiRecommendationPlanDialog', () => {
  function renderDialog(props: {
    isSubmitting?: boolean;
    onClose?: () => void;
    onSubmit?: (payload: CreateFoodPlanItemPayload) => Promise<void>;
  } = {}) {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    const onClose = props.onClose ?? vi.fn();
    const onSubmit = props.onSubmit ?? vi.fn(async () => undefined);
    act(() => {
      root?.render(
        <AiRecommendationPlanDialog
          request={{
            messageId: 'message-1',
            partId: 'part-1',
            cardId: 'card-1',
            targetDate: '2026-06-15',
            mealType: 'dinner',
            recommendation: {
              entityType: 'food',
              entityId: 'food-1',
              foodId: 'food-1',
              name: '番茄炒蛋',
              image: null,
              reason: '适合明晚快速准备。',
              evidence: [],
            },
          }}
          isSubmitting={Boolean(props.isSubmitting)}
          onClose={onClose}
          onSubmit={onSubmit}
        />,
      );
    });
    return { onClose, onSubmit, view: container };
  }

  it('prefills the queried date and meal type before creating a plan item', async () => {
    const submitted: CreateFoodPlanItemPayload[] = [];
    const { view } = renderDialog({
      onSubmit: async (payload) => {
        submitted.push(payload);
      },
    });

    expect(view.querySelector<HTMLInputElement>('input[type="date"]')?.value).toBe('2026-06-15');
    expect(view.querySelector<HTMLButtonElement>('.ai-recommendation-meal-options .active')?.textContent).toBe('晚餐');

    await act(async () => {
      view.querySelector<HTMLFormElement>('form')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });

    expect(submitted).toEqual([
      {
        food_id: 'food-1',
        plan_date: '2026-06-15',
        meal_type: 'dinner',
        note: '来自 AI 推荐：适合明晚快速准备。',
      },
    ]);
  });

  it('keeps the dialog open while a plan item is submitting', () => {
    const { onClose, view } = renderDialog({ isSubmitting: true });

    act(() => view.querySelector<HTMLDivElement>('.workspace-overlay-backdrop')?.click());
    act(() => view.querySelector<HTMLButtonElement>('.workspace-overlay-close')?.click());
    act(() => view.querySelector<HTMLButtonElement>('button.ui-form-actions-secondary')?.click());

    expect(view.querySelector('.workspace-overlay-root.ai-recommendation-plan-root')).not.toBeNull();
    expect(onClose).not.toHaveBeenCalled();
  });
});
