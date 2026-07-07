// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FoodSceneDialogs } from './FoodSceneDialogs';
import type { FoodSceneCardView, FoodSceneFormMode, ManagedFoodScene } from './useFoodSceneState';

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

function buildSceneCard(): FoodSceneCardView {
  return {
    id: 'scene-1',
    name: '工作日晚餐',
    description: '快手、省心',
    imagePrompt: '',
    imageUrl: '',
    imageAsset: null,
    custom: true,
    count: 3,
  };
}

function buildSceneDraft(): ManagedFoodScene {
  return {
    id: 'scene-1',
    name: '工作日晚餐',
    description: '快手、省心',
    imagePrompt: '一桌轻食晚餐',
    imageAssetId: 'asset-1',
    imageAssetUrl: '/assets/scene.webp',
    custom: true,
    hidden: false,
  };
}

function findButton(view: HTMLElement, text: string) {
  return Array.from(view.querySelectorAll<HTMLButtonElement>('button')).find((button) =>
    button.textContent?.includes(text),
  );
}

function renderDialogs(options: {
  isSceneManagerOpen?: boolean;
  sceneFormMode?: FoodSceneFormMode;
  isUpdatingScene?: boolean;
} = {}) {
  const onCloseManager = vi.fn();
  const onCloseSceneForm = vi.fn();
  const view = attachRoot();
  act(() => {
    root?.render(
      <FoodSceneDialogs
        isSceneManagerOpen={options.isSceneManagerOpen ?? false}
        sceneFormMode={options.sceneFormMode ?? null}
        sceneCards={[buildSceneCard()]}
        sceneDraft={buildSceneDraft()}
        sceneImageState={{ isGenerating: false, errorMessage: null }}
        isUpdatingScene={options.isUpdatingScene}
        onCloseManager={onCloseManager}
        onOpenCreateScene={vi.fn()}
        onOpenEditScene={vi.fn()}
        onDeleteScene={vi.fn()}
        onCloseSceneForm={onCloseSceneForm}
        onSubmitScene={vi.fn()}
        onGenerateSceneImage={vi.fn()}
        onSceneDraftChange={vi.fn()}
        resolveFoodAssetUrl={(url) => url}
      />,
    );
  });
  return { onCloseManager, onCloseSceneForm, view };
}

describe('FoodSceneDialogs', () => {
  it('uses the shared food overlay frame and closes the manager when idle', () => {
    const { onCloseManager, view } = renderDialogs({ isSceneManagerOpen: true });

    expect(view.querySelector('.workspace-overlay-root.food-workspace-overlay-root')).not.toBeNull();
    expect(view.querySelector('.food-scene-manager-modal')).not.toBeNull();
    expect(view.textContent).toContain('工作日晚餐');

    act(() => view.querySelector<HTMLDivElement>('.workspace-overlay-backdrop')?.click());
    act(() => view.querySelector<HTMLButtonElement>('.workspace-overlay-close')?.click());

    expect(onCloseManager).toHaveBeenCalledTimes(2);
  });

  it('locks manager actions and keeps it open while scenes are updating', () => {
    const { onCloseManager, view } = renderDialogs({ isSceneManagerOpen: true, isUpdatingScene: true });

    expect(findButton(view, '新建场景')?.disabled).toBe(true);
    expect(findButton(view, '编辑')?.disabled).toBe(true);
    expect(findButton(view, '删除')?.disabled).toBe(true);

    act(() => view.querySelector<HTMLDivElement>('.workspace-overlay-backdrop')?.click());
    act(() => view.querySelector<HTMLButtonElement>('.workspace-overlay-close')?.click());

    expect(onCloseManager).not.toHaveBeenCalled();
  });

  it('locks the scene form and keeps it open while saving', () => {
    const { onCloseSceneForm, view } = renderDialogs({ sceneFormMode: 'edit', isUpdatingScene: true });

    expect(view.querySelector('.workspace-overlay-footer .food-scene-form-actions')).not.toBeNull();
    expect(view.querySelector('.food-scene-form-actions .ui-form-actions-row')).not.toBeNull();
    expect(findButton(view, '处理中...')?.disabled).toBe(true);
    expect(findButton(view, '取消')?.disabled).toBe(true);
    expect(findButton(view, '重新生成')?.disabled).toBe(true);
    expect(findButton(view, '移除')?.disabled).toBe(true);
    expect(Array.from(view.querySelectorAll<HTMLInputElement>('input.text-input')).every((input) => input.disabled)).toBe(true);

    act(() => view.querySelector<HTMLDivElement>('.workspace-overlay-backdrop')?.click());
    act(() => view.querySelector<HTMLButtonElement>('.workspace-overlay-close')?.click());

    expect(onCloseSceneForm).not.toHaveBeenCalled();
  });
});
