// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RecipeSceneManagerDialog } from './RecipeSceneManagerDialog';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

function renderDialog() {
  const onClose = vi.fn();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  act(() => {
    root?.render(
      <RecipeSceneManagerDialog
        categoryCards={[]}
        managedScenes={[]}
        sceneFormMode={null}
        editingSceneName={null}
        sceneDraft={{ name: '', description: '', imagePrompt: '' }}
        sceneImageState={{ isGenerating: false, errorMessage: null, jobId: null }}
        generatingSceneName={null}
        isUpdatingScene={false}
        onClose={onClose}
        onOpenCreateForm={vi.fn()}
        onCloseForm={vi.fn()}
        onChangeDraft={vi.fn()}
        onSubmitDraft={vi.fn()}
        onGenerateImage={vi.fn()}
        onOpenEditForm={vi.fn()}
        onDeleteScene={vi.fn()}
        onRestoreScene={vi.fn()}
      />,
    );
  });
  return { onClose, view: container };
}

describe('RecipeSceneManagerDialog', () => {
  it('uses the shared workspace overlay frame and closes from overlay controls', () => {
    const { onClose, view } = renderDialog();

    expect(view.querySelector('.workspace-overlay-root')).not.toBeNull();
    expect(view.querySelector('.recipe-scene-modal')).not.toBeNull();
    expect(view.textContent).toContain('场景管理');
    expect(view.textContent).toContain('暂无可管理场景。');

    act(() => view.querySelector<HTMLDivElement>('.workspace-overlay-backdrop')?.click());
    act(() => view.querySelector<HTMLButtonElement>('.workspace-overlay-close')?.click());

    expect(onClose).toHaveBeenCalledTimes(2);
  });
});
