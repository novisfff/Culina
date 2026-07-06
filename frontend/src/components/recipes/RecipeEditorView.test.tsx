import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../../api/client';
import type { Ingredient } from '../../api/types';
import { RecipeEditorView } from './RecipeEditorView';
import type { RecipeDraftIngredient, RecipeFormState } from './RecipeWorkspaceModel';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

const tomato: Ingredient = {
  id: 'ingredient-tomato',
  family_id: 'family-1',
  name: '番茄',
  category: '蔬菜',
  default_unit: '个',
  unit_conversions: [],
  default_storage: '冷藏',
  default_expiry_mode: 'days',
  default_expiry_days: 3,
  default_low_stock_threshold: 1,
  notes: '',
  image: null,
  created_at: '2026-05-01T10:00:00Z',
  updated_at: '2026-05-01T10:00:00Z',
};

const okra: Ingredient = {
  ...tomato,
  id: 'ingredient-okra',
  name: '秋葵',
  default_unit: '根',
  default_storage: '常温',
};

function buildIngredient(id: string, name: string): Ingredient {
  return {
    ...tomato,
    id,
    name,
  };
}

function recipeForm(): RecipeFormState {
  return {
    title: '',
    servings: '2',
    prepMinutes: '15',
    difficulty: 'easy',
    steps: [],
    tips: '',
    sceneTags: '',
    images: {},
    autoCreateFood: true,
  };
}

function changeInput(input: HTMLInputElement, value: string) {
  act(() => {
    const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    valueSetter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function renderEditor(options: {
  selectIngredientRow?: ReturnType<typeof vi.fn>;
  ingredientRows?: RecipeDraftIngredient[];
  ingredients?: Ingredient[];
} = {}) {
  const selectIngredientRow = options.selectIngredientRow ?? vi.fn();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  await act(async () => {
    root?.render(
      <QueryClientProvider client={queryClient}>
        <RecipeEditorView
          isEditing={false}
          isRecipeAiApplied={false}
          selectedRecipeId={null}
          form={recipeForm()}
          setForm={vi.fn()}
          ingredientRows={options.ingredientRows ?? [{ id: 'row-1', ingredient_id: '', ingredient_name: '', quantity: '', unit: '个', note: '' }]}
          ingredients={options.ingredients ?? [tomato]}
          sceneTagDraft=""
          setSceneTagDraft={vi.fn()}
          sceneSelectOptions={[]}
          editorSceneTags={[]}
          visibleStepTips={{}}
          stepKeyPointSlots={{}}
          editorCoverUrl={null}
          editorReferenceUrl={null}
          editorCoverAsset={undefined}
          editorIngredientCount={0}
          editorStepCount={0}
          editorCompletionItems={[]}
          editorCompletionPercent={0}
          aiSourceSummary={[]}
          recipeDraftError={null}
          isRecipeDraftBusy={false}
          recipeImageState={{ isGenerating: false, errorMessage: null }}
          recipeDraftGenerationStage="idle"
          recipeDraftButtonLabel="生成草稿"
          recipeImagePayload={{ entity_type: 'recipe', title: '', food_names: [], ingredient_names: [], scene: '' }}
          submitDisabled={false}
          onBack={vi.fn()}
          onSubmit={vi.fn()}
          onDelete={vi.fn()}
          onOpenDraftDialog={vi.fn()}
          updateIngredientRow={vi.fn()}
          selectIngredientRow={selectIngredientRow}
          updateIngredientNote={vi.fn()}
          updateIngredientRequirement={vi.fn()}
          addIngredientRow={vi.fn()}
          removeIngredientRow={vi.fn()}
          updateStepDraft={vi.fn()}
          getStepKeyPointValues={() => []}
          getStepKeyPointRowCount={() => 1}
          addStepTip={vi.fn()}
          addStepKeyPoint={vi.fn()}
          updateStepKeyPoint={vi.fn()}
          removeStepKeyPoint={vi.fn()}
          commitSceneTagDraft={vi.fn()}
          handleRecipeImageUpload={vi.fn()}
          handleRecipeImageGenerate={vi.fn()}
          resetRecipeImageInput={vi.fn()}
        />
      </QueryClientProvider>
    );
  });
  return { selectIngredientRow };
}

async function waitForAssertion(assertion: () => void) {
  let lastError: unknown;
  for (let index = 0; index < 20; index += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10);
        await Promise.resolve();
      });
    }
  }
  throw lastError;
}

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('RecipeEditorView ingredient picker', () => {
  it('hides quantity controls for selected presence-only ingredients from search results', async () => {
    await renderEditor({
      ingredients: [tomato],
      ingredientRows: [{
        id: 'row-1',
        ingredient_id: 'ingredient-oil',
        ingredient_name: '食用油',
        quantity: '',
        unit: '毫升',
        note: '',
        quantity_tracking_mode: 'not_track_quantity',
      } as RecipeDraftIngredient],
    });

    expect(container?.textContent).toContain('用量写在步骤或备注里');
    expect(container?.querySelector('.recipe-editor-ingredient-qty-group')).toBeNull();
  });

  it('searches ingredients through the API and selects the returned option', async () => {
    vi.useFakeTimers();
    const getIngredients = vi.spyOn(api, 'getIngredients').mockImplementation(async (params = {}) => (
      params.q ? [okra] : [tomato]
    ));
    const selectIngredientRow = vi.fn();

    await renderEditor({ selectIngredientRow });
    const trigger = container?.querySelector('.recipe-ingredient-picker-trigger');
    expect(trigger).toBeNull();

    const select = container?.querySelector('.recipe-ingredient-picker .ui-searchable-resource-select');
    expect(select).toBeTruthy();

    await act(async () => {
      container?.querySelector<HTMLInputElement>('.recipe-ingredient-picker [role="searchbox"]')?.focus();
    });
    await waitForAssertion(() => {
      expect(getIngredients).toHaveBeenCalledWith({ q: '', limit: 20, offset: 0 });
    });

    expect(container?.querySelector('.recipe-ingredient-picker-search')).toBeNull();
    expect(container?.querySelector('.recipe-ingredient-picker-panel')).toBeNull();
    const input = container?.querySelector<HTMLInputElement>('.recipe-ingredient-picker [role="searchbox"]');
    expect(input).toBeTruthy();

    changeInput(input!, '西');
    changeInput(input!, '西红柿');
    expect(getIngredients).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(299);
    });
    expect(getIngredients).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });

    expect(getIngredients).toHaveBeenCalledWith({ q: '西红柿', limit: 20, offset: 0 });
    expect(getIngredients).toHaveBeenCalledTimes(2);
    await waitForAssertion(() => {
      expect(container?.textContent).toContain('秋葵');
    });

    const option = Array.from(container?.querySelectorAll<HTMLButtonElement>('[role="option"]') ?? [])
      .find((button) => button.textContent?.includes('秋葵'));
    await act(async () => {
      option?.click();
    });

    expect(selectIngredientRow).toHaveBeenCalledWith('row-1', okra);
  });

  it('loads the next ingredient page when the picker list reaches the bottom', async () => {
    vi.useFakeTimers();
    const firstPage = Array.from({ length: 20 }, (_, index) => buildIngredient(`ingredient-page-1-${index}`, `食材 ${index + 1}`));
    const nextIngredient = buildIngredient('ingredient-next-page', '下一页食材');
    const getIngredients = vi.spyOn(api, 'getIngredients').mockImplementation(async (params = {}) => (
      params.offset === 20 ? [nextIngredient] : firstPage
    ));

    await renderEditor({ ingredients: [] });
    await act(async () => {
      container?.querySelector<HTMLInputElement>('.recipe-ingredient-picker [role="searchbox"]')?.focus();
    });

    await waitForAssertion(() => {
      expect(container?.textContent).toContain('食材 20');
    });

    const list = container?.querySelector<HTMLDivElement>('.ui-searchable-resource-select-list');
    expect(list).not.toBeNull();
    Object.defineProperty(list, 'scrollHeight', { value: 200, configurable: true });
    Object.defineProperty(list, 'clientHeight', { value: 100, configurable: true });
    Object.defineProperty(list, 'scrollTop', { value: 96, configurable: true });

    await act(async () => {
      list?.dispatchEvent(new Event('scroll', { bubbles: true }));
      await Promise.resolve();
    });

    await waitForAssertion(() => {
      expect(getIngredients).toHaveBeenCalledWith({ q: '', limit: 20, offset: 20 });
      expect(container?.textContent).toContain('下一页食材');
    });
  });
});
