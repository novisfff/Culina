// @vitest-environment jsdom

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
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

function buildRecommendedSceneCard(): FoodSceneCardView {
  return {
    name: '孩子也能吃',
    description: '口味温和的家庭菜',
    imagePrompt: '',
    imageUrl: '',
    imageAsset: null,
    custom: false,
    count: 0,
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

type RenderDialogOptions = {
  isSceneManagerOpen?: boolean;
  sceneFormMode?: FoodSceneFormMode;
  isUpdatingScene?: boolean;
  sceneCards?: FoodSceneCardView[];
};

function renderDialogs(options: RenderDialogOptions = {}) {
  const onCloseManager = vi.fn();
  const onCloseSceneForm = vi.fn();
  const onOpenCreateScene = vi.fn();
  const onOpenEditScene = vi.fn();
  const onDeleteScene = vi.fn();
  const view = attachRoot();
  let currentOptions = options;

  function rerender(nextOptions: RenderDialogOptions = {}) {
    currentOptions = { ...currentOptions, ...nextOptions };
    act(() => root?.render(
      <FoodSceneDialogs
        isSceneManagerOpen={currentOptions.isSceneManagerOpen ?? false}
        sceneFormMode={currentOptions.sceneFormMode ?? null}
        sceneCards={currentOptions.sceneCards ?? [buildSceneCard()]}
        sceneDraft={buildSceneDraft()}
        sceneImageState={{ isGenerating: false, errorMessage: null }}
        isUpdatingScene={currentOptions.isUpdatingScene}
        onCloseManager={onCloseManager}
        onOpenCreateScene={onOpenCreateScene}
        onOpenEditScene={onOpenEditScene}
        onDeleteScene={onDeleteScene}
        onCloseSceneForm={onCloseSceneForm}
        onSubmitScene={vi.fn()}
        onGenerateSceneImage={vi.fn()}
        onSceneDraftChange={vi.fn()}
        resolveFoodAssetUrl={(url) => url}
      />,
    ));
  }

  rerender();
  return { onCloseManager, onCloseSceneForm, onDeleteScene, onOpenCreateScene, onOpenEditScene, rerender, view };
}

describe('FoodSceneDialogs', () => {
  it('keeps mobile scene actions horizontal beside the thumbnail', () => {
    const styles = readFileSync(resolve(__dirname, '../../styles/05-workspace-overlays.css'), 'utf8');
    const sceneStylesStart = styles.indexOf('.food-scene-manager-modal.workspace-modal');
    const mobileStylesStart = styles.indexOf('@media (max-width: 720px)', sceneStylesStart);
    const mobileStylesEnd = styles.indexOf('\n}\n\n.recipe-shopping-modal', mobileStylesStart) + 2;
    const mobileStyles = styles.slice(mobileStylesStart, mobileStylesEnd);

    expect(mobileStyles).toContain('grid-template-areas:');
    expect(mobileStyles).toContain('"thumb copy"');
    expect(mobileStyles).toContain('"thumb actions"');
    expect(mobileStyles).toContain('justify-content: flex-end;');
    expect(mobileStyles).toContain('.food-scene-row-primary-action {');
    expect(mobileStyles).toContain('min-width: 72px;');
    expect(mobileStyles).toContain('.food-scene-row-menu-root {\n    position: static;');
    expect(mobileStyles).toContain('min-width: 156px;');
    expect(mobileStyles).not.toContain('flex-direction: column-reverse;');
  });

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
    expect(view.querySelector<HTMLButtonElement>('[aria-label="更多操作：工作日晚餐"]')?.disabled).toBe(true);

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

  it('uses compact card actions for custom and recommended scenes', () => {
    const { view } = renderDialogs({
      isSceneManagerOpen: true,
      sceneCards: [buildSceneCard(), buildRecommendedSceneCard()],
    });

    expect(view.querySelectorAll('.food-scene-row')).toHaveLength(2);
    expect(findButton(view, '编辑')).not.toBeUndefined();
    expect(findButton(view, '创建')).not.toBeUndefined();
    expect(view.querySelector('[aria-label="更多操作：工作日晚餐"]')).not.toBeNull();
    expect(view.querySelector('[aria-label="更多操作：孩子也能吃"]')).toBeNull();
    expect(findButton(view, '删除')).toBeUndefined();
  });

  it('requires confirmation before deleting a custom scene', () => {
    const { onDeleteScene, view } = renderDialogs({ isSceneManagerOpen: true });
    const moreButton = view.querySelector<HTMLButtonElement>('[aria-label="更多操作：工作日晚餐"]');

    act(() => moreButton?.click());

    expect(moreButton?.getAttribute('aria-expanded')).toBe('true');
    expect(view.querySelector('[role="menu"]')).not.toBeNull();
    expect(findButton(view, '删除场景')).not.toBeUndefined();

    act(() => findButton(view, '删除场景')?.click());

    expect(view.textContent).toContain('删除「工作日晚餐」？');
    expect(onDeleteScene).not.toHaveBeenCalled();

    act(() => findButton(view, '删除场景')?.click());
    act(() => findButton(view, '删除场景')?.click());

    expect(onDeleteScene).toHaveBeenCalledTimes(1);
    expect(onDeleteScene).toHaveBeenCalledWith('scene-1');
  });

  it('closes the scene menu with Escape without deleting', () => {
    const { onDeleteScene, view } = renderDialogs({ isSceneManagerOpen: true });

    act(() => view.querySelector<HTMLButtonElement>('[aria-label="更多操作：工作日晚餐"]')?.click());
    expect(view.querySelector('[role="menu"]')).not.toBeNull();

    act(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));

    expect(view.querySelector('[role="menu"]')).toBeNull();
    expect(onDeleteScene).not.toHaveBeenCalled();
  });

  it('closes the scene menu when clicking outside the active card', () => {
    const { view } = renderDialogs({ isSceneManagerOpen: true });

    act(() => view.querySelector<HTMLButtonElement>('[aria-label="更多操作：工作日晚餐"]')?.click());
    expect(view.querySelector('[role="menu"]')).not.toBeNull();

    act(() => view.querySelector<HTMLElement>('.food-scene-manager-toolbar')?.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true })));

    expect(view.querySelector('[role="menu"]')).toBeNull();
  });

  it('closes delete confirmation after the deleted scene disappears', () => {
    const { rerender, view } = renderDialogs({ isSceneManagerOpen: true });

    act(() => view.querySelector<HTMLButtonElement>('[aria-label="更多操作：工作日晚餐"]')?.click());
    act(() => findButton(view, '删除场景')?.click());
    act(() => findButton(view, '删除场景')?.click());
    expect(view.textContent).toContain('删除「工作日晚餐」？');

    rerender({ sceneCards: [] });

    expect(view.textContent).not.toContain('删除「工作日晚餐」？');
  });

  it('clears delete confirmation when the manager closes externally', () => {
    const { rerender, view } = renderDialogs({ isSceneManagerOpen: true });

    act(() => view.querySelector<HTMLButtonElement>('[aria-label="更多操作：工作日晚餐"]')?.click());
    act(() => findButton(view, '删除场景')?.click());
    expect(view.textContent).toContain('删除「工作日晚餐」？');

    rerender({ isSceneManagerOpen: false });

    expect(view.textContent).not.toContain('删除「工作日晚餐」？');
  });

  it('shows a useful empty state with a nearby create action', () => {
    const { onOpenCreateScene, view } = renderDialogs({ isSceneManagerOpen: true, sceneCards: [] });

    expect(view.textContent).toContain('还没有场景');
    expect(view.textContent).toContain('新建一个常用场景，快速整理食物');
    expect(view.querySelector('.food-scene-empty')).not.toBeNull();

    const createButtons = Array.from(view.querySelectorAll<HTMLButtonElement>('button')).filter((button) =>
      button.textContent?.includes('新建场景'),
    );
    expect(createButtons).toHaveLength(2);

    act(() => createButtons[1]?.click());
    expect(onOpenCreateScene).toHaveBeenCalledTimes(1);
  });
});
