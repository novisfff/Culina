// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { IDLE_IMAGE_GENERATION_STATE } from '../../hooks/useImageComposer';
import { FoodEditorForm } from './FoodEditorForm';
import type { FoodFormState } from './FoodWorkspaceModel';

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

function buildForm(): FoodFormState {
  return {
    name: '番茄炒蛋',
    type: 'takeout',
    category: '',
    sceneTags: '',
    suitableMealTypes: ['dinner'],
    sourceName: '',
    purchaseSource: '',
    scene: '',
    notes: '',
    routineNote: '',
    price: '',
    rating: '',
    repurchase: 'unknown',
    expiryDate: '',
    stockQuantity: '',
    stockUnit: '份',
    storageLocation: '',
    favorite: false,
    recipeId: '',
    images: {},
  };
}

function renderForm(options: { completionPercent?: number; isSavingFood?: boolean; form?: FoodFormState } = {}) {
  const view = attachRoot();
  act(() => {
    root?.render(
      <FoodEditorForm
        embedded
        availableSceneTagOptions={[]}
        canSubmit={!options.isSavingFood}
        completionItems={[]}
        completionPercent={options.completionPercent ?? 0}
        currentRecipe={null}
        editorFoodTitle="番茄炒蛋"
        editorProfile={{ title: '补充食物资料', description: '补充来源和备注。' }}
        editorRecipeMeta="未绑定菜谱"
        form={options.form ?? buildForm()}
        imageState={IDLE_IMAGE_GENERATION_STATE}
        isSavingFood={options.isSavingFood}
        isSceneTagPickerOpen={false}
        isSelfMade={false}
        isUpdatingScene={false}
        newSceneTagName=""
        sceneTags={[]}
        view="create"
        onAddSceneTag={vi.fn()}
        onBack={vi.fn()}
        onCreateAndAddSceneTag={vi.fn()}
        onFormChange={vi.fn()}
        onGenerateImage={vi.fn()}
        onEditRecipe={vi.fn()}
        onRemoveSceneTag={vi.fn()}
        onResetImage={vi.fn()}
        onSceneTagPickerToggle={vi.fn()}
        onSubmit={vi.fn()}
        onToggleMealType={vi.fn()}
        onUploadImage={vi.fn()}
        resolveAssetUrl={(url) => url}
        setNewSceneTagName={vi.fn()}
      />,
    );
  });
  return view;
}

function findButton(view: HTMLElement, text: string) {
  return Array.from(view.querySelectorAll<HTMLButtonElement>('button')).find((button) =>
    button.textContent?.includes(text),
  );
}

describe('FoodEditorForm', () => {
  it('locks the return action while saving food', () => {
    const view = renderForm({ isSavingFood: true });

    expect(findButton(view, '保存中...')?.disabled).toBe(true);
    expect(findButton(view, '返回食物库')?.disabled).toBe(true);
  });

  it('keeps the return action available when idle', () => {
    const view = renderForm();

    expect(findButton(view, '返回食物库')?.disabled).toBe(false);
  });

  it('exposes the completion bar as a bounded progress indicator', () => {
    const view = renderForm({ completionPercent: 72 });
    const bar = view.querySelector<HTMLElement>('.food-editor-completion-bar');
    const fill = view.querySelector<HTMLElement>('.food-editor-completion-bar span');

    expect(bar?.getAttribute('role')).toBe('progressbar');
    expect(bar?.getAttribute('aria-valuemin')).toBe('0');
    expect(bar?.getAttribute('aria-valuemax')).toBe('100');
    expect(bar?.getAttribute('aria-valuenow')).toBe('72');
    expect(bar?.style.getPropertyValue('--food-editor-completion')).toBe('72%');
    expect(fill?.style.width).toBe('');
  });

  it('shows storage location choices for ready-like stock only', () => {
    const readyView = renderForm({ form: { ...buildForm(), type: 'instant', storageLocation: '常温' } });
    expect(readyView.textContent).toContain('存放位置');
    expect(findButton(readyView, '冷藏')).not.toBeUndefined();
    expect(findButton(readyView, '冷冻')).not.toBeUndefined();
    expect(findButton(readyView, '常温')).not.toBeUndefined();

    act(() => root?.unmount());
    readyView.remove();
    root = null;
    container = null;

    const takeoutView = renderForm({ form: { ...buildForm(), type: 'takeout' } });
    expect(takeoutView.textContent).not.toContain('存放位置');
  });
});
