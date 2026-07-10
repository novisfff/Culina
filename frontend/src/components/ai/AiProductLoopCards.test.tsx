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
  it('submits selected inventory intake candidates as a new user-controlled turn', async () => {
    const onProductLoopPrompt = vi.fn();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(
        <ResultCard
          card={{
            id: 'inventory-intake-1',
            type: 'inventory_intake_candidates',
            title: '识别到 2 个可入库食材',
            data: {
              items: [
                {
                  ingredientId: 'ingredient-tomato',
                  name: '番茄',
                  quantityMode: 'track_quantity',
                  quantity: '2',
                  unit: '个',
                  selected: true,
                  warnings: [],
                  confidence: 0.93,
                  sourceLabel: '小票上的番茄',
                },
                {
                  ingredientId: 'ingredient-salt',
                  name: '盐',
                  quantityMode: 'not_track_quantity',
                  quantity: null,
                  unit: '份',
                  selected: true,
                  warnings: ['该食材只记录有无，不记录数量'],
                },
              ],
              unresolvedLabels: ['紫苏'],
            },
          } as unknown as AiResultCard}
          onProductLoopPrompt={onProductLoopPrompt}
        />,
      );
    });

    expect(container.textContent).toContain('番茄');
    expect(container.textContent).toContain('紫苏');
    const quantityInput = container.querySelector<HTMLInputElement>('input[type="number"]');
    expect(quantityInput?.value).toBe('2');
    await act(async () => {
      if (quantityInput) {
        const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
        valueSetter?.call(quantityInput, '3');
        quantityInput.dispatchEvent(new Event('input', { bubbles: true }));
        quantityInput.dispatchEvent(new Event('change', { bubbles: true }));
      }
    });
    const selectionInputs = container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
    await act(async () => selectionInputs[1]?.click());
    const action = Array.from(container.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent?.includes('按选中项准备入库'));
    expect(action?.disabled).toBe(false);
    await act(async () => action?.click());

    expect(onProductLoopPrompt).toHaveBeenCalledWith({
      message: '按这些项目准备入库',
      quick_task: 'inventory_analysis',
      subject: {
        source: 'inventory_intake_candidates',
        extra: {
          intakeCandidates: [
            {
              ingredientId: 'ingredient-tomato',
              quantity: '3',
              unit: '个',
            },
          ],
          unresolvedLabels: ['紫苏'],
        },
      },
    });
  });
});
