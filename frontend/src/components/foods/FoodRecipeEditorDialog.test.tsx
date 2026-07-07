// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FoodRecipeEditorDialog } from './FoodRecipeEditorDialog';

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

function renderDialog(options: { isEditing?: boolean; isSaving?: boolean } = {}) {
  const onClose = vi.fn();
  const view = attachRoot();
  act(() => {
    root?.render(
      <FoodRecipeEditorDialog
        currentRecipeTitle="番茄炒蛋"
        isEditing={Boolean(options.isEditing)}
        isSaving={options.isSaving}
        onClose={onClose}
      >
        <div data-testid="recipe-editor-view">菜谱表单</div>
      </FoodRecipeEditorDialog>,
    );
  });
  return { onClose, view };
}

describe('FoodRecipeEditorDialog', () => {
  it('uses the shared food overlay frame and closes when idle', () => {
    const { onClose, view } = renderDialog({ isEditing: true });

    expect(view.querySelector('.workspace-overlay-root.food-workspace-overlay-root')).not.toBeNull();
    expect(view.querySelector('.food-recipe-editor-modal')).not.toBeNull();
    expect(view.textContent).toContain('编辑菜谱和用料');
    expect(view.textContent).toContain('正在编辑「番茄炒蛋」');

    act(() => view.querySelector<HTMLDivElement>('.workspace-overlay-backdrop')?.click());
    act(() => view.querySelector<HTMLButtonElement>('.workspace-overlay-close')?.click());

    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('keeps the dialog open while saving', () => {
    const { onClose, view } = renderDialog({ isSaving: true });

    act(() => view.querySelector<HTMLDivElement>('.workspace-overlay-backdrop')?.click());
    act(() => view.querySelector<HTMLButtonElement>('.workspace-overlay-close')?.click());

    expect(onClose).not.toHaveBeenCalled();
  });
});
