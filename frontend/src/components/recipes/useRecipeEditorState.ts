import { useState } from 'react';
import type { Difficulty, Ingredient } from '../../api/types';
import {
  MAX_STEP_KEY_POINTS,
} from './RecipeWorkspaceOptions';
import {
  applyRecipeIngredientRequirement,
  buildFormFromRecipe,
  createEmptyRecipeStepDraft,
  defaultIngredientRows,
  defaultRecipeDraftAiForm,
  defaultRecipeForm,
  getRecipeShoppingRequirement,
  newDraftId,
  type RecipeDraftAiFormState,
  type RecipeDraftGenerationStage,
  type RecipeDraftIngredient,
  type RecipeFormState,
  type RecipeNotice,
  type RecipeShoppingRequirement,
  type RecipeStepDraft,
} from './RecipeWorkspaceModel';
import type { RecipeCardViewModel, RecipeQuickFilter, RecipeSortMode, RecipeWorkspaceView } from './workspaceModel';

export function useRecipeEditorState(args: {
  ingredients: Ingredient[];
}) {
  const [view, setView] = useState<RecipeWorkspaceView>('library');
  const [selectedRecipeId, setSelectedRecipeId] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [quickFilter, setQuickFilter] = useState<RecipeQuickFilter>('recommend');
  const [sceneFilter, setSceneFilter] = useState('all');
  const [difficultyFilter, setDifficultyFilter] = useState<'all' | Difficulty>('all');
  const [sortMode, setSortMode] = useState<RecipeSortMode>('updated');
  const [recommendationPage, setRecommendationPage] = useState(0);
  const [form, setForm] = useState<RecipeFormState>(() => defaultRecipeForm());
  const [ingredientRows, setIngredientRows] = useState<RecipeDraftIngredient[]>(() => defaultIngredientRows());
  const [recipeDraftAiForm, setRecipeDraftAiForm] = useState<RecipeDraftAiFormState>(() => defaultRecipeDraftAiForm());
  const [isRecipeDraftDialogOpen, setIsRecipeDraftDialogOpen] = useState(false);
  const [sceneTagDraft, setSceneTagDraft] = useState('');
  const [visibleStepTips, setVisibleStepTips] = useState<Record<string, boolean>>({});
  const [stepKeyPointSlots, setStepKeyPointSlots] = useState<Record<string, number>>({});
  const [recipeDraftGenerationStage, setRecipeDraftGenerationStage] = useState<RecipeDraftGenerationStage>('idle');
  const [recipeDraftError, setRecipeDraftError] = useState<string | null>(null);
  const [isRecipeAiApplied, setIsRecipeAiApplied] = useState(false);

  function resetForm() {
    setForm(defaultRecipeForm());
    setIngredientRows(defaultIngredientRows());
    setRecipeDraftAiForm(defaultRecipeDraftAiForm());
    setRecipeDraftError(null);
    setSceneTagDraft('');
    setVisibleStepTips({});
    setStepKeyPointSlots({});
  }

  function openCreate() {
    resetForm();
    setSelectedRecipeId(null);
    setView('create');
  }

  function openDetail(card: RecipeCardViewModel) {
    setSelectedRecipeId(card.recipe.id);
    setView('detail');
  }

  function openEdit(card: RecipeCardViewModel) {
    const next = buildFormFromRecipe(card.recipe);
    setSelectedRecipeId(card.recipe.id);
    setForm(next.form);
    setIngredientRows(next.ingredients);
    setRecipeDraftAiForm(defaultRecipeDraftAiForm());
    setRecipeDraftError(null);
    setSceneTagDraft('');
    setVisibleStepTips({});
    setStepKeyPointSlots({});
    setView('edit');
  }

  function updateIngredientRow(id: string, key: 'ingredient_id' | 'quantity' | 'unit' | 'note', value: string) {
    setIngredientRows((current) =>
      current.map((item) => {
        if (item.id !== id) return item;
        if (key === 'ingredient_id') {
          const ingredient = args.ingredients.find((entry) => entry.id === value);
          return {
            ...item,
            ingredient_id: value,
            ingredient_name: ingredient?.name ?? '',
            unit: ingredient?.default_unit ?? item.unit,
          };
        }
        return { ...item, [key]: value };
      })
    );
  }

  function selectIngredientRow(id: string, ingredient: Ingredient | null) {
    setIngredientRows((current) =>
      current.map((item) =>
        item.id === id
          ? {
              ...item,
              ingredient_id: ingredient?.id ?? '',
              ingredient_name: ingredient?.name ?? '',
              unit: ingredient?.default_unit ?? item.unit,
            }
          : item
      )
    );
  }

  function updateIngredientNote(id: string, value: string) {
    setIngredientRows((current) =>
      current.map((item) =>
        item.id === id ? { ...item, note: applyRecipeIngredientRequirement(value, getRecipeShoppingRequirement(item)) } : item
      )
    );
  }

  function updateIngredientRequirement(id: string, requirement: RecipeShoppingRequirement) {
    setIngredientRows((current) =>
      current.map((item) => (item.id === id ? { ...item, note: applyRecipeIngredientRequirement(item.note, requirement) } : item))
    );
  }

  function updateStepDraft(stepId: string, patch: Partial<RecipeStepDraft>) {
    setForm((current) => ({
      ...current,
      steps: current.steps.map((item) => (item.id === stepId ? { ...item, ...patch } : item)),
    }));
  }

  function getStepKeyPointValues(step: RecipeStepDraft) {
    return step.keyPoints ? step.keyPoints.split('\n').slice(0, MAX_STEP_KEY_POINTS) : [];
  }

  function addStepTip(stepId: string) {
    setVisibleStepTips((current) => ({ ...current, [stepId]: true }));
  }

  function getStepKeyPointRowCount(step: RecipeStepDraft) {
    return Math.min(MAX_STEP_KEY_POINTS, Math.max(getStepKeyPointValues(step).length, stepKeyPointSlots[step.id] ?? 0));
  }

  function addStepKeyPoint(step: RecipeStepDraft) {
    const nextCount = Math.min(MAX_STEP_KEY_POINTS, getStepKeyPointRowCount(step) + 1);
    setStepKeyPointSlots((current) => ({ ...current, [step.id]: nextCount }));
  }

  function updateStepKeyPoint(step: RecipeStepDraft, index: number, value: string) {
    const rowCount = Math.max(getStepKeyPointRowCount(step), index + 1);
    const rows = Array.from({ length: Math.min(MAX_STEP_KEY_POINTS, rowCount) }, (_, rowIndex) => getStepKeyPointValues(step)[rowIndex] ?? '');
    rows[index] = value;
    updateStepDraft(step.id, { keyPoints: rows.join('\n') });
    setStepKeyPointSlots((current) => ({ ...current, [step.id]: rows.length }));
  }

  function removeStepKeyPoint(step: RecipeStepDraft, index: number) {
    const rowCount = getStepKeyPointRowCount(step);
    const rows = Array.from({ length: rowCount }, (_, rowIndex) => getStepKeyPointValues(step)[rowIndex] ?? '').filter((_, rowIndex) => rowIndex !== index);
    updateStepDraft(step.id, { keyPoints: rows.join('\n') });
    setStepKeyPointSlots((current) => ({ ...current, [step.id]: rows.length }));
  }

  function addIngredientRow() {
    setIngredientRows((current) => [
      ...current,
      { id: newDraftId('ingredient'), ingredient_name: '', ingredient_id: '', quantity: '', unit: '个', note: '' },
    ]);
  }

  function removeIngredientRow(id: string) {
    setIngredientRows((current) => (current.length > 1 ? current.filter((item) => item.id !== id) : current));
  }

  function commitSceneTagDraft() {
    const nextTags = sceneTagDraft
      .split(/[、,\n]/)
      .map((item) => item.trim())
      .filter(Boolean);
    if (nextTags.length === 0) return;
    setForm((current) => ({
      ...current,
      sceneTags: [...new Set([...current.sceneTags.split(/[、,\n]/).map((item) => item.trim()).filter(Boolean), ...nextTags])].join('、'),
    }));
    setSceneTagDraft('');
  }

  return {
    view,
    setView,
    selectedRecipeId,
    setSelectedRecipeId,
    search,
    setSearch,
    quickFilter,
    setQuickFilter,
    sceneFilter,
    setSceneFilter,
    difficultyFilter,
    setDifficultyFilter,
    sortMode,
    setSortMode,
    recommendationPage,
    setRecommendationPage,
    form,
    setForm,
    ingredientRows,
    setIngredientRows,
    recipeDraftAiForm,
    setRecipeDraftAiForm,
    isRecipeDraftDialogOpen,
    setIsRecipeDraftDialogOpen,
    sceneTagDraft,
    setSceneTagDraft,
    visibleStepTips,
    setVisibleStepTips,
    stepKeyPointSlots,
    setStepKeyPointSlots,
    recipeDraftGenerationStage,
    setRecipeDraftGenerationStage,
    recipeDraftError,
    setRecipeDraftError,
    isRecipeAiApplied,
    setIsRecipeAiApplied,
    resetForm,
    openCreate,
    openDetail,
    openEdit,
    updateIngredientRow,
    selectIngredientRow,
    updateIngredientNote,
    updateIngredientRequirement,
    updateStepDraft,
    getStepKeyPointValues,
    addStepTip,
    getStepKeyPointRowCount,
    addStepKeyPoint,
    updateStepKeyPoint,
    removeStepKeyPoint,
    addIngredientRow,
    removeIngredientRow,
    commitSceneTagDraft,
  };
}
