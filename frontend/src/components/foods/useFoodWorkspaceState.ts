import { useEffect, useMemo, useState, type FormEvent } from 'react';
import type { Food, FoodPayload, FoodScene, FoodType, MealType, Recipe } from '../../api/types';
import { getMediaIds, getPendingImageJobId } from '../../lib/aiImages';
import { MEAL_TYPE_LABELS, formatDate, splitTags, todayKey } from '../../lib/ui';
import type { FoodGovernanceIssue, FoodWorkspaceLens } from './FoodWorkspaceOptions';
import { buildFoodPayloadFromForm, foodToForm, makeBlankFoodForm, type FoodFormState } from './FoodWorkspaceModel';

type UseFoodWorkspaceStateArgs = {
  foods: Food[];
  foodScenes: FoodScene[];
  recipes: Recipe[];
  navigationRequest?: {
    foodId: string;
    requestId: number;
    target?: 'detail' | 'edit' | 'quickMeal';
    quickMealAction?: 'eat' | 'cook';
  } | null;
  createFood: (payload: FoodPayload) => Promise<Food>;
  updateFood: (foodId: string, payload: FoodPayload) => Promise<Food>;
  createFoodScene: (payload: {
    name: string;
    description: string;
    image_prompt: string;
    image_asset_id?: string;
    pending_image_job_id?: string | null;
    hidden: boolean;
    custom: boolean;
    sort_order: number;
  }) => Promise<FoodScene>;
  quickAddMeal: (payload: { food_id: string; date: string; meal_type: MealType; servings: number; note: string }) => Promise<unknown>;
};

export function useFoodWorkspaceState(args: UseFoodWorkspaceStateArgs) {
  const [view, setView] = useState<'list' | 'create' | 'edit'>('list');
  const [editingFood, setEditingFood] = useState<Food | null>(null);
  const [detailFoodId, setDetailFoodId] = useState<string | null>(null);
  const [form, setForm] = useState<FoodFormState>(() => makeBlankFoodForm());
  const [search, setSearch] = useState('');
  const [lensFilter, setLensFilter] = useState<FoodWorkspaceLens>('all');
  const [recommendationPage, setRecommendationPage] = useState(0);
  const [governanceIssueFilter, setGovernanceIssueFilter] = useState<'all' | FoodGovernanceIssue>('all');
  const [typeFilter, setTypeFilter] = useState<'all' | FoodType>('all');
  const [mealFilter, setMealFilter] = useState<'all' | MealType>('all');
  const [sceneFilter, setSceneFilter] = useState('all');
  const [isSceneTagPickerOpen, setIsSceneTagPickerOpen] = useState(false);
  const [newSceneTagName, setNewSceneTagName] = useState('');
  const [feedback, setFeedback] = useState('');

  const editorSceneTags = useMemo(() => splitTags(form.sceneTags), [form.sceneTags]);

  useEffect(() => {
    if (!args.navigationRequest) return;
    if (args.navigationRequest?.target === 'edit' || args.navigationRequest?.target === 'quickMeal') return;
    setEditingFood(null);
    setDetailFoodId(args.navigationRequest.foodId);
    setView('list');
  }, [args.navigationRequest?.requestId]);

  function resetEditorState() {
    setFeedback('');
    setIsSceneTagPickerOpen(false);
    setNewSceneTagName('');
  }

  function openCreate(type: FoodType = 'takeout') {
    setEditingFood(null);
    setForm(makeBlankFoodForm(type));
    resetEditorState();
    setView('create');
  }

  function openEdit(food: Food) {
    setDetailFoodId(null);
    setEditingFood(food);
    setForm(foodToForm(food));
    resetEditorState();
    setView('edit');
  }

  function openDetail(food: Food) {
    setDetailFoodId(food.id);
  }

  function closeDetail() {
    setDetailFoodId(null);
  }

  async function submitFood(event: FormEvent<HTMLFormElement>, canSubmit: boolean, payloadOverride?: FoodPayload) {
    event.preventDefault();
    if (!canSubmit) return;
    const payload = payloadOverride ?? buildFoodPayloadFromForm(form, args.recipes, getMediaIds(form.images), getPendingImageJobId(form.images));
    if (editingFood) {
      await args.updateFood(editingFood.id, payload);
    } else {
      await args.createFood(payload);
    }
    setView('list');
    setEditingFood(null);
    setForm(makeBlankFoodForm());
    resetEditorState();
  }

  function toggleMealType(mealType: MealType, checked: boolean) {
    setForm((current) => ({
      ...current,
      suitableMealTypes: checked
        ? Array.from(new Set([...current.suitableMealTypes, mealType]))
        : current.suitableMealTypes.filter((item) => item !== mealType),
    }));
  }

  function removeSceneTag(tag: string) {
    setForm((current) => ({
      ...current,
      sceneTags: splitTags(current.sceneTags)
        .filter((item) => item !== tag)
        .join('、'),
    }));
  }

  function addSceneTag(tag: string) {
    const nextTag = tag.trim();
    if (!nextTag) return;
    setForm((current) => {
      const tags = splitTags(current.sceneTags);
      if (tags.includes(nextTag)) return current;
      return { ...current, sceneTags: [...tags, nextTag].join('、') };
    });
    setIsSceneTagPickerOpen(false);
    setNewSceneTagName('');
  }

  async function createAndAddSceneTag() {
    const name = newSceneTagName.trim();
    if (!name) return;
    const existing = args.foodScenes.find((scene) => scene.name === name) || args.foods.some((food) => (food.scene_tags ?? []).includes(name));
    if (existing) {
      addSceneTag(name);
      return;
    }
    await args.createFoodScene({
      name,
      description: '',
      image_prompt: '',
      hidden: false,
      custom: true,
      sort_order: 0,
    });
    addSceneTag(name);
  }

  async function quickAdd(food: Food, mealType: MealType, date = todayKey()) {
    await args.quickAddMeal({ food_id: food.id, date, meal_type: mealType, servings: 1, note: '' });
    setFeedback(`${food.name} 已记到${date === todayKey() ? '今天' : formatDate(date)}${MEAL_TYPE_LABELS[mealType]}`);
  }

  function clearFoodFilters() {
    setSearch('');
    setTypeFilter('all');
    setMealFilter('all');
    setLensFilter('all');
    setSceneFilter('all');
    setGovernanceIssueFilter('all');
  }

  function openGovernanceIssue(issue: 'all' | FoodGovernanceIssue) {
    setLensFilter('needsInfo');
    setGovernanceIssueFilter(issue);
  }

  return {
    view,
    setView,
    editingFood,
    detailFoodId,
    closeDetail,
    form,
    setForm,
    search,
    setSearch,
    lensFilter,
    setLensFilter,
    recommendationPage,
    setRecommendationPage,
    governanceIssueFilter,
    setGovernanceIssueFilter,
    typeFilter,
    setTypeFilter,
    mealFilter,
    setMealFilter,
    sceneFilter,
    setSceneFilter,
    isSceneTagPickerOpen,
    setIsSceneTagPickerOpen,
    newSceneTagName,
    setNewSceneTagName,
    feedback,
    setFeedback,
    editorSceneTags,
    openCreate,
    openEdit,
    openDetail,
    submitFood,
    toggleMealType,
    removeSceneTag,
    addSceneTag,
    createAndAddSceneTag,
    quickAdd,
    clearFoodFilters,
    openGovernanceIssue,
  };
}
