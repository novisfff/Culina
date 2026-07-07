// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RecipeCookSessionState } from './RecipeWorkspaceModel';
import { RecipeCookFinishDialog } from './RecipeCookFinishDialog';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

function attachRoot() {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  return container;
}

function buildSession(): RecipeCookSessionState {
  return {
    currentStepIndex: 0,
    checkedIngredientIds: [],
    completedStepIds: [],
    timers: [],
    activeTimerId: '',
    servings: '2',
    date: '2026-07-07',
    mealType: 'dinner',
    createMealLog: true,
    planItemId: null,
    adjustments: '',
    resultNote: '',
    rating: '',
    aiAssistantMessages: [],
  };
}

function findButton(view: HTMLElement, text: string) {
  return Array.from(view.querySelectorAll<HTMLButtonElement>('button')).find((button) =>
    button.textContent?.includes(text),
  );
}

function renderDialog(options: { isCooking?: boolean } = {}) {
  const onClose = vi.fn();
  const view = attachRoot();
  act(() => {
    root?.render(
      <RecipeCookFinishDialog
        recipeTitle="番茄炒蛋"
        cookPreview={null}
        cookPreviewError={null}
        isCookPreviewLoading={false}
        session={buildSession()}
        isCooking={options.isCooking}
        submitDisabled={false}
        onUpdateSession={vi.fn()}
        onClose={onClose}
        onSubmit={vi.fn()}
      />,
    );
  });
  return { onClose, view };
}

describe('RecipeCookFinishDialog', () => {
  it('uses the shared recipe overlay frame and closes when idle', () => {
    const { onClose, view } = renderDialog();

    expect(view.querySelector('.workspace-overlay-root.recipe-workspace-overlay-root')).not.toBeNull();
    expect(view.querySelector('.recipe-cook-finish-modal')).not.toBeNull();
    expect(view.querySelector('.workspace-overlay-footer .recipe-cook-finish-actions')).not.toBeNull();
    expect(view.textContent).toContain('完成烹饪：番茄炒蛋');

    act(() => view.querySelector<HTMLDivElement>('.workspace-overlay-backdrop')?.click());
    act(() => view.querySelector<HTMLButtonElement>('.workspace-overlay-close')?.click());
    act(() => findButton(view, '稍后处理')?.click());

    expect(onClose).toHaveBeenCalledTimes(3);
  });

  it('keeps the dialog open while cooking is being submitted', () => {
    const { onClose, view } = renderDialog({ isCooking: true });
    const laterButton = findButton(view, '稍后处理');

    expect(laterButton?.disabled).toBe(true);

    act(() => view.querySelector<HTMLDivElement>('.workspace-overlay-backdrop')?.click());
    act(() => view.querySelector<HTMLButtonElement>('.workspace-overlay-close')?.click());
    act(() => laterButton?.click());

    expect(onClose).not.toHaveBeenCalled();
  });
});
