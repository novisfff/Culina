import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import type {
  CookRecipeRequest,
  CookRecipePreviewRequest,
  CookRecipePreviewResponse,
  CookRecipeResponse,
  Food,
  FoodPlanItem,
  Ingredient,
  InventoryItem,
  MealLog,
  MealType,
  Member,
  QuickAddMealLogPayload,
  Recipe,
  RecipePayload,
  ShoppingListItem,
  UpdateFoodPayload,
  UpdateMealLogPayload,
} from '../../api/types';
import type { CookLaunchContext } from '../../app/appNavigationModel';
import { FoodDetailDrawer } from '../../components/foods/FoodDetailDrawer';
import { FoodEditorForm } from '../../components/foods/FoodEditorForm';
import { FoodPlanDetailModal, type FoodPlanDetailFormState } from '../../components/foods/FoodPlanDetailModal';
import { FoodPlanDialog } from '../../components/foods/FoodPlanDialog';
import { FoodQuickMealDialog, type FoodQuickMealDialogState } from '../../components/foods/FoodQuickMealDialog';
import {
  buildFoodRelationViewModel,
  describeExpiry,
  getDefaultMealType,
  getFoodAudienceText,
  getFoodFactRows,
  getFoodMealHistory,
  getFoodSceneTags,
  getFoodStatus,
  getMealUsage,
  getPrimaryFoodActionLabel,
  getRepurchaseLabel,
  getSecondaryFoodActionLabel,
  isOutsideFood,
  isReadyLikeFood,
  normalizeFoodType,
} from '../../components/foods/FoodWorkspaceHelpers';
import {
  buildFoodPayloadFromForm,
  foodToForm,
  getFoodFormCompletionItems,
  getFoodImagePayload,
  type FoodFormState,
} from '../../components/foods/FoodWorkspaceModel';
import { MEAL_OPTIONS } from '../../components/foods/FoodWorkspaceOptions';
import { RecipeCookFinishDialog } from '../../components/recipes/RecipeCookFinishDialog';
import { RecipeDetailView } from '../../components/recipes/RecipeDetailView';
import { RecipeEditorView } from '../../components/recipes/RecipeEditorView';
import { RecipeShoppingDialog } from '../../components/recipes/RecipeShoppingDialog';
import { RecipeTaskSurface } from '../../components/recipes/RecipeTaskSurface';
import {
  buildRecipeImagePayload,
  buildRecipePayload,
  getRecipeDraftGenerationButtonLabel,
  resolveIngredientImageUrl,
} from '../../components/recipes/RecipeWorkspaceModel';
import { SHOPPING_UNIT_OPTIONS } from '../../components/recipes/RecipeWorkspaceOptions';
import { useRecipeCookState } from '../../components/recipes/useRecipeCookState';
import { useRecipeEditorState } from '../../components/recipes/useRecipeEditorState';
import { useRecipeShoppingState } from '../../components/recipes/useRecipeShoppingState';
import { buildRecipeCards, type RecipeWorkspaceView } from '../../components/recipes/workspaceModel';
import {
  ActionButton,
  ConfirmDialog,
  FormActions,
  StateBlock,
  WorkspaceModal,
  WorkspaceOverlayFrame,
} from '../../components/ui-kit';
import { useImageComposer } from '../../hooks/useImageComposer';
import { getMediaIds, getPendingImageJobId } from '../../lib/aiImages';
import { resolveAssetUrl } from '../../lib/assets';
import { addDateKeyDays } from '../../lib/date';
import { getFoodCover, getFoodCoverAsset, getImagePreview, splitTags, todayKey, formatDateTime, MEAL_TYPE_LABELS } from '../../lib/ui';
import { MealEnrichmentModal } from '../meals/MealEnrichmentModal';
import { buildMealTitle, getMealTone } from '../meals/MealLogWorkspaceModel';
import { MealLogIcon } from '../meals/MealLogIcons';
import { MealHistorySurface } from '../meals/MealHistorySurface';
import type { ResolvedEatTask } from './EatWorkspaceViewModel';

function resolveUrl(url: string) {
  return resolveAssetUrl(url) ?? url;
}

function getFoodPlanDateParts(dateKey: string) {
  const [year, month, day] = dateKey.split('-').map(Number);
  const date = new Date(year, (month || 1) - 1, day || 1);
  return {
    day: String(day || 1),
    month: String(month || 1),
    weekday: new Intl.DateTimeFormat('zh-CN', { weekday: 'short' }).format(date),
  };
}

function resolveErrorMessage(reason: unknown, fallback: string) {
  if (reason instanceof Error && reason.message.trim()) {
    return reason.message;
  }
  return fallback;
}

export function EatFoodTaskBody(props: {
  food: Food;
  recipes: Recipe[];
  ingredients: Ingredient[];
  inventoryItems: InventoryItem[];
  mealLogs: MealLog[];
  foods: Food[];
  isQuickAdding?: boolean;
  isSavingFood?: boolean;
  isUpdatingPlan?: boolean;
  updateFood: (foodId: string, payload: UpdateFoodPayload) => Promise<unknown>;
  createFoodPlanItem: (payload: {
    food_id: string;
    plan_date: string;
    meal_type: MealType;
    note: string;
  }) => Promise<unknown>;
  onClose: () => void;
  onEditRecipe: (food: Food) => void;
  onOpenLogs: () => void;
  onStartCook: (recipeId: string) => void;
  onQuickAdd: (food: Food, mealType: MealType) => void;
}) {
  const [isEditing, setIsEditing] = useState(false);
  const [form, setForm] = useState<FoodFormState>(() => foodToForm(props.food));
  const [isPlanDialogOpen, setIsPlanDialogOpen] = useState(false);
  const [planForm, setPlanForm] = useState({
    foodId: props.food.id,
    planDate: todayKey(),
    mealType: getDefaultMealType(props.food),
    note: '',
  });
  const [planFoodSearch, setPlanFoodSearch] = useState(props.food.name);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [isSceneTagPickerOpen, setIsSceneTagPickerOpen] = useState(false);
  const [newSceneTagName, setNewSceneTagName] = useState('');

  useEffect(() => {
    setForm(foodToForm(props.food));
    setIsEditing(false);
    setSaveError(null);
    setIsSceneTagPickerOpen(false);
    setNewSceneTagName('');
  }, [props.food.id, props.food.updated_at]);

  const imageComposer = useImageComposer({
    value: form.images,
    payload: getFoodImagePayload(form, props.recipes),
    onChange: (images) => setForm((current) => ({ ...current, images })),
    uploadErrorMessage: '图片上传成功，但生成主图失败。',
    generateErrorMessage: '生成主图失败，请稍后再试。',
  });

  const sceneTags = splitTags(form.sceneTags);
  const availableSceneTagOptions = useMemo(() => {
    const names = new Set<string>();
    props.foods.forEach((food) => getFoodSceneTags(food).forEach((tag) => names.add(tag)));
    sceneTags.forEach((tag) => names.add(tag));
    return Array.from(names)
      .filter((tag) => !sceneTags.includes(tag))
      .sort((left, right) => left.localeCompare(right, 'zh-CN'));
  }, [props.foods, sceneTags]);

  const usage = getMealUsage(props.food, props.mealLogs);
  const expiry = describeExpiry(props.food);
  const normalizedType = normalizeFoodType(props.food);
  const status = getFoodStatus(props.food, usage, expiry, props.recipes);
  const factRows = getFoodFactRows(props.food, usage, expiry);
  const history = getFoodMealHistory(props.food, props.mealLogs);
  const relation = buildFoodRelationViewModel(
    props.food,
    props.recipes,
    props.ingredients,
    props.inventoryItems,
    props.mealLogs,
    props.foods,
  );
  const linkedRecipeCard = relation.linkedRecipeCard;
  const recipe =
    linkedRecipeCard?.recipe
    ?? (props.food.recipe_id ? props.recipes.find((item) => item.id === props.food.recipe_id) ?? null : null);
  const coverAsset = getFoodCoverAsset(props.food, props.recipes);
  const cover = coverAsset?.url;
  const detailMealOptions =
    props.food.suitable_meal_types.length > 0
      ? MEAL_OPTIONS.filter((meal) => props.food.suitable_meal_types.includes(meal.value))
      : MEAL_OPTIONS;

  const isSelfMade = normalizedType === 'selfMade';
  const completionItems = getFoodFormCompletionItems(form, props.food, props.recipes);
  const completionPercent = Math.round(
    (completionItems.filter((item) => item.done).length / Math.max(completionItems.length, 1)) * 100,
  );
  const planDateOptions = Array.from({ length: 14 }, (_, index) => addDateKeyDays(todayKey(), index));

  async function handleSubmitFood(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaveError(null);
    try {
      const payload = buildFoodPayloadFromForm(
        form,
        props.recipes,
        getMediaIds(form.images).length > 0
          ? getMediaIds(form.images)
          : props.food.images.map((image) => image.id).filter(Boolean),
        getPendingImageJobId(form.images),
      );
      await props.updateFood(props.food.id, {
        ...payload,
        expected_row_version: props.food.row_version,
      });
      setIsEditing(false);
    } catch (reason) {
      setSaveError(resolveErrorMessage(reason, '保存食物失败'));
    }
  }

  async function handleSubmitPlan(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!planForm.foodId) return;
    await props.createFoodPlanItem({
      food_id: planForm.foodId,
      plan_date: planForm.planDate,
      meal_type: planForm.mealType,
      note: planForm.note.trim(),
    });
    setIsPlanDialogOpen(false);
  }

  return (
    <>
      <FoodDetailDrawer
        food={props.food}
        audienceText={getFoodAudienceText(props.food, props.mealLogs)}
        cover={cover}
        coverAsset={coverAsset}
        detailMealOptions={detailMealOptions}
        expiry={expiry}
        factRows={factRows}
        history={history}
        isOutsideFood={isOutsideFood(props.food)}
        isQuickAdding={props.isQuickAdding}
        isReadyLikeFood={isReadyLikeFood(props.food)}
        normalizedType={normalizedType}
        recipe={recipe}
        relation={relation}
        status={status}
        usage={usage}
        getDefaultMealType={getDefaultMealType}
        getPrimaryFoodActionLabel={getPrimaryFoodActionLabel}
        getRepurchaseLabel={getRepurchaseLabel}
        getSceneTags={getFoodSceneTags}
        getSecondaryFoodActionLabel={getSecondaryFoodActionLabel}
        onClose={props.onClose}
        onEdit={() => setIsEditing(true)}
        onEditRecipe={props.onEditRecipe}
        onOpenLogs={props.onOpenLogs}
        onOpenPlanDialog={() => {
          setPlanForm({
            foodId: props.food.id,
            planDate: todayKey(),
            mealType: getDefaultMealType(props.food),
            note: '',
          });
          setPlanFoodSearch(props.food.name);
          setIsPlanDialogOpen(true);
        }}
        onStartCook={props.onStartCook}
        onQuickAdd={props.onQuickAdd}
        resolveAssetUrl={resolveUrl}
        overlayRootClassName="eat-task-body-overlay-root"
      />

      {isEditing ? (
        <WorkspaceOverlayFrame
          rootClassName="eat-task-body-overlay-root"
          onClose={() => {
            if (!props.isSavingFood) setIsEditing(false);
          }}
          closeOnBackdrop={!props.isSavingFood}
        >
          <WorkspaceModal
            title="编辑食物"
            description="补充名称、库存和日常信息。"
            eyebrow="食物资料"
            className="food-editor-modal"
            onClose={() => {
              if (!props.isSavingFood) setIsEditing(false);
            }}
          >
            <FoodEditorForm
              embedded
              availableSceneTagOptions={availableSceneTagOptions}
              canSubmit={!props.isSavingFood && Boolean(form.name.trim() || isSelfMade)}
              completionItems={completionItems}
              completionPercent={completionPercent}
              currentRecipe={recipe}
              editorFoodTitle={form.name || props.food.name}
              editorProfile={{
                title: isSelfMade ? '家常菜资料' : '食物资料',
                description: '保存后会更新这份家常菜的基础信息。',
              }}
              editorRecipeCover={recipe?.images[0]?.url}
              editorRecipeMeta={recipe ? `${recipe.ingredient_items.length} 项用料 · ${recipe.steps.length} 步` : '未绑定做法'}
              form={form}
              imageState={imageComposer.state}
              isSavingFood={props.isSavingFood}
              isSceneTagPickerOpen={isSceneTagPickerOpen}
              isSelfMade={isSelfMade}
              isUpdatingScene={false}
              newSceneTagName={newSceneTagName}
              sceneTags={sceneTags}
              submitLabel="保存"
              view="edit"
              onAddSceneTag={(tag) =>
                setForm((current) => ({
                  ...current,
                  sceneTags: [...new Set([...splitTags(current.sceneTags), tag])].join('、'),
                }))
              }
              onBack={() => {
                if (!props.isSavingFood) setIsEditing(false);
              }}
              onCreateAndAddSceneTag={() => {
                const name = newSceneTagName.trim();
                if (!name) return;
                setForm((current) => ({
                  ...current,
                  sceneTags: [...new Set([...splitTags(current.sceneTags), name])].join('、'),
                }));
                setNewSceneTagName('');
                setIsSceneTagPickerOpen(false);
              }}
              onFormChange={setForm}
              onGenerateImage={(mode) => {
                void imageComposer.generate(mode);
              }}
              onEditRecipe={() => {
                setIsEditing(false);
                props.onEditRecipe(props.food);
              }}
              onRemoveSceneTag={(tag) =>
                setForm((current) => ({
                  ...current,
                  sceneTags: splitTags(current.sceneTags).filter((item) => item !== tag).join('、'),
                }))
              }
              onResetImage={() => imageComposer.reset()}
              onSceneTagPickerToggle={() => setIsSceneTagPickerOpen((current) => !current)}
              onSubmit={(event) => {
                void handleSubmitFood(event);
              }}
              onToggleMealType={(mealType, checked) =>
                setForm((current) => ({
                  ...current,
                  suitableMealTypes: checked
                    ? [...new Set([...current.suitableMealTypes, mealType])]
                    : current.suitableMealTypes.filter((item) => item !== mealType),
                }))
              }
              onUploadImage={(files) => {
                void imageComposer.upload(files);
              }}
              resolveAssetUrl={resolveUrl}
              setNewSceneTagName={setNewSceneTagName}
            />
            {saveError ? <p className="subtle" role="alert">{saveError}</p> : null}
          </WorkspaceModal>
        </WorkspaceOverlayFrame>
      ) : null}

      <FoodPlanDialog
        isOpen={isPlanDialogOpen}
        selectedPlanFood={props.food}
        foods={props.foods}
        recipes={props.recipes}
        planFoodSearch={planFoodSearch}
        planForm={planForm}
        todayDate={todayKey()}
        planDateOptions={planDateOptions}
        isUpdatingPlan={props.isUpdatingPlan}
        onClose={() => setIsPlanDialogOpen(false)}
        onSubmit={(event) => {
          void handleSubmitPlan(event);
        }}
        onClearPlanFoodSelection={() => {
          setPlanForm((current) => ({ ...current, foodId: '' }));
          setPlanFoodSearch('');
        }}
        onPlanFoodSearchChange={setPlanFoodSearch}
        onSelectPlanFood={(food) => {
          setPlanForm((current) => ({
            ...current,
            foodId: food.id,
            mealType: getDefaultMealType(food),
          }));
          setPlanFoodSearch(food.name);
        }}
        onPlanDateChange={(value) => setPlanForm((current) => ({ ...current, planDate: value }))}
        onMealTypeChange={(value) => setPlanForm((current) => ({ ...current, mealType: value }))}
        onPlanNoteChange={(value) => setPlanForm((current) => ({ ...current, note: value }))}
        resolveFoodAssetUrl={resolveUrl}
        getFoodCover={getFoodCover}
        getFoodCoverAsset={getFoodCoverAsset}
        getDefaultMealType={getDefaultMealType}
        getPlanDateParts={getFoodPlanDateParts}
        normalizeFoodType={normalizeFoodType}
      />
    </>
  );
}

export function EatPlanTaskBody(props: {
  item: FoodPlanItem;
  food: Food | null;
  recipes: Recipe[];
  isUpdatingPlan?: boolean;
  isCompleting?: boolean;
  isUpdatingMeal?: boolean;
  members: Member[];
  onClose: () => void;
  onUpdate: (itemId: string, payload: { plan_date?: string; meal_type?: MealType; note?: string }) => Promise<unknown>;
  onDelete: (itemId: string) => Promise<unknown>;
  onComplete: (item: FoodPlanItem) => Promise<MealLog>;
  updateMealLog: (mealLogId: string, payload: UpdateMealLogPayload) => Promise<unknown>;
  onStartCook?: (recipeId: string, foodPlanItemId: string) => void;
}) {
  const [isEditing, setIsEditing] = useState(false);
  const [recordedMeal, setRecordedMeal] = useState<MealLog | null>(null);
  const [completionError, setCompletionError] = useState<string | null>(null);
  const activeItemIdRef = useRef(props.item.id);
  const completionRequestRef = useRef(0);
  activeItemIdRef.current = props.item.id;
  const [form, setForm] = useState<FoodPlanDetailFormState>({
    planDate: props.item.plan_date,
    mealType: props.item.meal_type,
    note: props.item.note ?? '',
  });

  useEffect(() => {
    completionRequestRef.current += 1;
    setIsEditing(false);
    setRecordedMeal(null);
    setCompletionError(null);
    setForm({
      planDate: props.item.plan_date,
      mealType: props.item.meal_type,
      note: props.item.note ?? '',
    });
  }, [props.item.id, props.item.plan_date, props.item.meal_type, props.item.note]);

  function resetEdit() {
    setForm({
      planDate: props.item.plan_date,
      mealType: props.item.meal_type,
      note: props.item.note ?? '',
    });
    setIsEditing(false);
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await props.onUpdate(props.item.id, {
      plan_date: form.planDate,
      meal_type: form.mealType,
      note: form.note,
    });
    setIsEditing(false);
  }

  if (recordedMeal) {
    return (
      <MealEnrichmentModal
        open
        meal={recordedMeal}
        members={props.members}
        isUpdating={Boolean(props.isUpdatingMeal)}
        updateMealLog={props.updateMealLog}
        onClose={props.onClose}
        overlayRootClassName="eat-task-body-overlay-root"
        formId="eat-plan-meal-enrichment-form"
      />
    );
  }

  return (
    <FoodPlanDetailModal
      item={props.item}
      food={props.food}
      recipes={props.recipes}
      form={form}
      isEditing={isEditing}
      isUpdatingPlan={props.isUpdatingPlan}
      isCompleting={props.isCompleting}
      actionError={completionError}
      onClose={props.onClose}
      onChangeForm={setForm}
      onEditingChange={setIsEditing}
      onResetEdit={resetEdit}
      onSubmit={(event) => {
        void handleSubmit(event);
      }}
      onComplete={() => {
        if (props.item.recipe_id && props.onStartCook) {
          props.onStartCook(props.item.recipe_id, props.item.id);
          return;
        }
        setCompletionError(null);
        const completingItemId = props.item.id;
        const requestId = ++completionRequestRef.current;
        void props.onComplete(props.item).then((meal) => {
          if (activeItemIdRef.current === completingItemId && completionRequestRef.current === requestId) {
            setRecordedMeal(meal);
          }
        }).catch((reason) => {
          if (activeItemIdRef.current === completingItemId && completionRequestRef.current === requestId) {
            setCompletionError(resolveErrorMessage(reason, '记录这餐失败，请稍后重试。'));
          }
        });
      }}
      onDelete={() => {
        void props.onDelete(props.item.id).then(() => props.onClose());
      }}
      resolveAssetUrl={resolveUrl}
      overlayRootClassName="eat-task-body-overlay-root"
    />
  );
}

function EatRecipeEditTaskBody(props: {
  foodId: string;
  recipeId: string;
  selectedCard: NonNullable<ReturnType<typeof buildRecipeCards>[number]>;
  editor: ReturnType<typeof useRecipeEditorState>;
  ingredients: Ingredient[];
  isUpdatingRecipe?: boolean;
  updateRecipe: (recipeId: string, payload: RecipePayload) => Promise<unknown>;
  saveError: string | null;
  setSaveError: (value: string | null) => void;
  onClose: () => void;
}) {
  const { editor, selectedCard } = props;
  const recipeImageComposer = useImageComposer({
    value: editor.form.images,
    payload: buildRecipeImagePayload(editor.form, editor.ingredientRows, props.ingredients),
    onChange: (images) => editor.setForm((current) => ({ ...current, images })),
    uploadErrorMessage: '参考图上传或 AI 主图生成失败',
    generateErrorMessage: 'AI 主图生成失败',
  });

  const editorIngredientCount = editor.ingredientRows.filter(
    (item) => item.ingredient_id || item.ingredient_name.trim(),
  ).length;
  const editorStepCount = editor.form.steps.filter((step) => step.text.trim()).length;
  const editorSceneTags = splitTags(editor.form.sceneTags);
  const editorCoverAsset = getImagePreview(editor.form.images) ?? selectedCard.recipe.images[0];
  const editorCoverUrl = editorCoverAsset?.url ? resolveUrl(editorCoverAsset.url) : undefined;
  const editorCompletionItems = [
    { label: '已填写基础信息', done: Boolean(editor.form.title.trim() && Number(editor.form.servings) > 0) },
    { label: '已添加原料', done: editorIngredientCount > 0 },
    { label: '已添加步骤', done: editorStepCount > 0 },
    { label: '已设置封面', done: Boolean(editorCoverAsset) },
  ];
  const editorCompletionPercent = Math.round(
    (editorCompletionItems.filter((item) => item.done).length / editorCompletionItems.length) * 100,
  );

  return (
    <div className="eat-recipe-task-body" data-testid="eat-recipe-task-body" data-mode="edit">
      <RecipeEditorView
        isEditing
        isRecipeAiApplied={false}
        selectedRecipeId={props.recipeId}
        form={editor.form}
        setForm={editor.setForm}
        ingredientRows={editor.ingredientRows}
        ingredients={props.ingredients}
        sceneTagDraft={editor.sceneTagDraft}
        setSceneTagDraft={editor.setSceneTagDraft}
        sceneSelectOptions={editorSceneTags}
        editorSceneTags={editorSceneTags}
        visibleStepTips={editor.visibleStepTips}
        editorCoverUrl={editorCoverUrl}
        editorCoverAsset={editorCoverAsset}
        editorIngredientCount={editorIngredientCount}
        editorStepCount={editorStepCount}
        editorCompletionItems={editorCompletionItems}
        editorCompletionPercent={editorCompletionPercent}
        recipeDraftError={props.saveError}
        isRecipeDraftBusy={false}
        recipeImageState={recipeImageComposer.state}
        recipeDraftButtonLabel={getRecipeDraftGenerationButtonLabel('idle')}
        submitDisabled={Boolean(props.isUpdatingRecipe)}
        isUpdatingRecipe={props.isUpdatingRecipe}
        showAiDraftAction={false}
        showDeleteAction={false}
        compactHeader
        entityLabel="做法"
        submitLabel="保存做法"
        backLabel="关闭"
        onBack={props.onClose}
        onSubmit={(event) => {
          event.preventDefault();
          const payload = buildRecipePayload(
            editor.form,
            editor.ingredientRows,
            props.ingredients,
            getPendingImageJobId(editor.form.images),
          );
          void props
            .updateRecipe(props.recipeId, payload)
            .then(() => props.onClose())
            .catch((reason) => {
              props.setSaveError(resolveErrorMessage(reason, '保存做法失败'));
            });
        }}
        onDelete={async () => undefined}
        onOpenDraftDialog={() => undefined}
        updateIngredientRow={editor.updateIngredientRow}
        selectIngredientRow={editor.selectIngredientRow}
        updateIngredientNote={editor.updateIngredientNote}
        updateIngredientRequirement={editor.updateIngredientRequirement}
        addIngredientRow={editor.addIngredientRow}
        removeIngredientRow={editor.removeIngredientRow}
        updateStepDraft={editor.updateStepDraft}
        getStepKeyPointValues={editor.getStepKeyPointValues}
        getStepKeyPointRowCount={editor.getStepKeyPointRowCount}
        addStepTip={editor.addStepTip}
        addStepKeyPoint={editor.addStepKeyPoint}
        updateStepKeyPoint={editor.updateStepKeyPoint}
        removeStepKeyPoint={editor.removeStepKeyPoint}
        commitSceneTagDraft={editor.commitSceneTagDraft}
        handleRecipeImageUpload={async (files) => {
          await recipeImageComposer.upload(files);
        }}
        handleRecipeImageGenerate={async (mode) => {
          await recipeImageComposer.generate(mode);
        }}
        resetRecipeImageInput={() => recipeImageComposer.reset()}
      />
    </div>
  );
}

export function EatRecipeTaskBody(props: {
  foodId: string;
  recipeId: string;
  mode: 'view' | 'edit';
  recipes: Recipe[];
  foods: Food[];
  ingredients: Ingredient[];
  inventoryItems: InventoryItem[];
  mealLogs: MealLog[];
  isUpdatingRecipe?: boolean;
  updateRecipe: (recipeId: string, payload: RecipePayload) => Promise<unknown>;
  onClose: () => void;
  onCook: (foodId: string, recipeId: string) => void;
  onEdit: (recipeId: string) => void;
}) {
  const cards = useMemo(
    () => buildRecipeCards(props.recipes, props.ingredients, props.inventoryItems, props.mealLogs, props.foods),
    [props.foods, props.ingredients, props.inventoryItems, props.mealLogs, props.recipes],
  );
  const selectedCard = cards.find((card) => card.recipe.id === props.recipeId) ?? null;
  const editor = useRecipeEditorState({ ingredients: props.ingredients });
  const [editorSeeded, setEditorSeeded] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    if (props.mode !== 'edit' || !selectedCard || editorSeeded) return;
    editor.openEdit(selectedCard);
    setEditorSeeded(true);
  }, [editor, editorSeeded, props.mode, selectedCard]);

  useEffect(() => {
    setEditorSeeded(false);
    setSaveError(null);
  }, [props.recipeId, props.mode]);

  if (!selectedCard) {
    return (
      <WorkspaceOverlayFrame rootClassName="eat-task-body-overlay-root" onClose={props.onClose}>
        <WorkspaceModal title="做法" description="正在加载做法详情。" onClose={props.onClose}>
          <StateBlock status="loading" title="请稍候" description="正在准备做法内容。" />
        </WorkspaceModal>
      </WorkspaceOverlayFrame>
    );
  }

  if (props.mode === 'edit') {
    return (
      <EatRecipeEditTaskBody
        foodId={props.foodId}
        recipeId={props.recipeId}
        selectedCard={selectedCard}
        editor={editor}
        ingredients={props.ingredients}
        isUpdatingRecipe={props.isUpdatingRecipe}
        updateRecipe={props.updateRecipe}
        saveError={saveError}
        setSaveError={setSaveError}
        onClose={props.onClose}
      />
    );
  }

  const selectedReadyCount = selectedCard.ingredientAvailability.filter((item) => item.ready).length;
  const selectedIngredientCount = selectedCard.ingredientAvailability.length;
  const selectedShortageCount = selectedCard.shortages.length;

  return (
    <div className="eat-recipe-task-body" data-testid="eat-recipe-task-body" data-mode="view">
      <section className="recipe-task-surface recipe-task-surface-view" aria-label="做法">
        <header className="eat-recipe-task-header">
          <div>
            <p className="eyebrow">做法</p>
            <h2 className="eat-recipe-task-title">{selectedCard.recipe.title}</h2>
          </div>
          <ActionButton tone="secondary" size="compact" type="button" onClick={props.onClose}>
            关闭
          </ActionButton>
        </header>
        <RecipeDetailView
          selectedCard={selectedCard}
          selectedReadyCount={selectedReadyCount}
          selectedIngredientCount={selectedIngredientCount}
          selectedShortageCount={selectedShortageCount}
          isSelectedFavorite={false}
          selectedRecentCookLog={selectedCard.recipe.cook_logs[0] ?? null}
          selectedRecipePlanItems={[]}
          showPlanAction={false}
          showShoppingAction={false}
          showFavoriteAction={false}
          showEditAction
          showDeleteAction={false}
          compactHeader
          showHeroTitle={false}
          backLabel="关闭"
          onBack={props.onClose}
          onCook={() => props.onCook(props.foodId, props.recipeId)}
          onPlan={() => undefined}
          onShopping={() => undefined}
          onToggleFavorite={() => undefined}
          onEdit={() => props.onEdit(props.recipeId)}
          onDelete={async () => undefined}
        />
      </section>
    </div>
  );
}

export function EatCookTaskBody(props: {
  food: Food;
  recipe: Recipe;
  launchContext: CookLaunchContext;
  recipes: Recipe[];
  foods: Food[];
  ingredients: Ingredient[];
  inventoryItems: InventoryItem[];
  mealLogs: MealLog[];
  isCookingRecipe?: boolean;
  isCreatingShopping?: boolean;
  cookRecipe: (recipeId: string, payload: CookRecipeRequest) => Promise<CookRecipeResponse>;
  previewCookRecipe: (recipeId: string, payload: CookRecipePreviewRequest) => Promise<CookRecipePreviewResponse>;
  createShoppingItem: (payload: {
    title: string;
    quantity?: number | null;
    unit?: string | null;
    ingredient_id: string;
    quantity_mode?: ShoppingListItem['quantity_mode'];
    display_label?: string | null;
    reason: string;
  }) => Promise<ShoppingListItem>;
  onClose: () => void;
  onCompleted: () => void;
  onViewMealLog?: (mealLogId: string) => void;
  onResumePromptChange?: (open: boolean) => void;
  /** Authenticated user+family scope for v3 cook session persistence. */
  sessionScope?: { userId: string; familyId: string } | null;
}) {
  const cards = useMemo(
    () => buildRecipeCards(props.recipes, props.ingredients, props.inventoryItems, props.mealLogs, props.foods),
    [props.foods, props.ingredients, props.inventoryItems, props.mealLogs, props.recipes],
  );
  const selectedCard = cards.find((card) => card.recipe.id === props.recipe.id) ?? null;
  const planItemId =
    props.launchContext.source.kind === 'plan' ? props.launchContext.source.foodPlanItemId : null;

  const [view, setView] = useState<RecipeWorkspaceView>('cook');
  const [, setSelectedRecipeId] = useState<string | null>(props.recipe.id);
  const [launchSeeded, setLaunchSeeded] = useState(false);
  // Only auto-start cook once; cards refresh must not re-open the session.
  const [startRecipeId, setStartRecipeId] = useState<string | null>(props.recipe.id);

  const shopping = useRecipeShoppingState({
    ingredients: props.ingredients,
    createShoppingItem: props.createShoppingItem,
    showRecipeNotice: () => undefined,
  });

  const cookState = useRecipeCookState({
    cards,
    selectedCard,
    view,
    setView,
    setSelectedRecipeId,
    startRecipeId,
    startFoodPlanItemId: planItemId,
    startRecipeReturnTarget: null,
    onStartRecipeHandled: () => {
      setStartRecipeId(null);
    },
    previewCookRecipe: props.previewCookRecipe,
    cookRecipe: props.cookRecipe,
    isCookingRecipe: props.isCookingRecipe,
    showRecipeNotice: () => undefined,
    sessionScope: props.sessionScope ?? null,
    launchContext: props.launchContext,
    foodId: props.food.id,
    ownershipVerified: true,
    onViewMealLog: props.onViewMealLog,
    onCookFinished: props.onCompleted,
  });

  useEffect(() => {
    if (!cookState.cookSession || launchSeeded) return;
    // Restored v3 sessions keep their date/meal/servings/request ID.
    if (props.sessionScope && cookState.wasCookSessionRestored) {
      setLaunchSeeded(true);
      return;
    }
    cookState.updateCookSession({
      date: props.launchContext.date,
      mealType: props.launchContext.mealType,
      servings: String(props.launchContext.servings),
      planItemId,
    });
    setLaunchSeeded(true);
  }, [cookState, cookState.cookSession, cookState.wasCookSessionRestored, launchSeeded, planItemId, props.launchContext, props.sessionScope]);

  useEffect(() => {
    props.onResumePromptChange?.(Boolean(cookState.cookResumePrompt));
    return () => props.onResumePromptChange?.(false);
  }, [cookState.cookResumePrompt, props.onResumePromptChange]);

  if (cookState.cookResumePrompt) {
    return (
      <div className="eat-cook-task-body" data-testid="eat-cook-task-body">
        <ConfirmDialog
          open
          title="继续上次的做菜进度？"
          description="这道菜在当前餐次有一份最近保存的进度。你可以接着做，也可以重新开始。"
          confirmLabel="继续上次"
          cancelLabel="重新开始"
          closeLabel="关闭"
          rootClassName="eat-task-body-overlay-root eat-cook-confirm-root"
          modalClassName="eat-cook-confirm-modal"
          onClose={() => {
            cookState.dismissCookResumePrompt();
            props.onClose();
          }}
          onConfirm={cookState.continueSavedCook}
          onCancel={cookState.restartSavedCook}
        />
      </div>
    );
  }

  if (!cookState.activeCookCard || !cookState.cookSession) {
    return (
      <div className="eat-cook-task-body" data-testid="eat-cook-task-body">
        <WorkspaceOverlayFrame rootClassName="eat-task-body-overlay-root" onClose={props.onClose}>
          <WorkspaceModal title={props.recipe.title || '做菜'} description="烹饪流程准备中" onClose={props.onClose}>
            <StateBlock status="loading" title="正在打开烹饪" description="请稍候。" />
          </WorkspaceModal>
        </WorkspaceOverlayFrame>
      </div>
    );
  }

  return (
    <div className="eat-cook-task-body recipe-task-surface-cook" data-testid="eat-cook-task-body">
      <RecipeTaskSurface
        mode="cook"
        recipe={cookState.activeCookCard.recipe}
        food={props.food}
        launchContext={props.launchContext}
        onCompleted={() => props.onCompleted()}
        onClose={props.onClose}
        cook={{
          activeCookCard: cookState.activeCookCard,
          cookSession: cookState.cookSession,
          cookSteps: cookState.cookSteps,
          currentCookStep: cookState.currentCookStep,
          currentStepSuggestedSeconds: cookState.currentStepSuggestedSeconds,
          cookTimerDisplaySeconds: cookState.cookTimerDisplaySeconds,
          cookTimerDurationSeconds: cookState.cookTimerDurationSeconds,
          cookTimerProgress: cookState.cookTimerProgress,
          cookProgressPercent: cookState.cookProgressPercent,
          wasCookSessionRestored: cookState.wasCookSessionRestored,
          cookPreview: cookState.cookPreview,
          isCookTimerCustomOpen: cookState.isCookTimerCustomOpen,
          cookTimerJustStarted: cookState.cookTimerJustStarted,
          cookTimerPicker: cookState.cookTimerPicker,
          cookTimerMinuteWheelRef: cookState.cookTimerMinuteWheelRef,
          cookTimerSecondWheelRef: cookState.cookTimerSecondWheelRef,
          setCookTimerPicker: cookState.setCookTimerPicker,
          setIsCookTimerCustomOpen: cookState.setIsCookTimerCustomOpen,
          exitCookMode: () => {
            cookState.exitCookMode('source');
            props.onClose();
          },
          cookBackLabel: '关闭',
          cookBackTarget: 'source',
          cookExitTarget: 'source',
          jumpToCookStep: cookState.jumpToCookStep,
          moveCookStep: cookState.moveCookStep,
          completeCurrentCookStepAndContinue: cookState.completeCurrentCookStepAndContinue,
          resetActiveCookSession: cookState.resetActiveCookSession,
          openCookFinishDialog: () => cookState.setIsCookFinishOpen(true),
          openShoppingDialog: () => {
            if (cookState.activeCookCard) {
              shopping.openShoppingDialog(cookState.activeCookCard, () => undefined);
            }
          },
          confirmCustomCookTimer: cookState.confirmCustomCookTimer,
          openCustomCookTimer: cookState.openCustomCookTimer,
          selectCookTimerDuration: cookState.selectCookTimerDuration,
          resetCookTimer: cookState.resetCookTimer,
          toggleCookTimer: cookState.toggleCookTimer,
          addCookTimerSeconds: cookState.addCookTimerSeconds,
          toggleCookIngredient: cookState.toggleCookIngredient,
          timers: cookState.timers,
          activeTimerId: cookState.activeTimerId,
          addTimer: cookState.addTimer,
          deleteTimer: cookState.deleteTimer,
          selectTimer: cookState.selectTimer,
          toggleTimerById: cookState.toggleTimerById,
          startTimerById: cookState.startTimerById,
          pauseTimerById: cookState.pauseTimerById,
          resetTimerById: cookState.resetTimerById,
          addTimerSecondsById: cookState.addTimerSecondsById,
          setTimerById: cookState.setTimerById,
          setCookAssistantMessages: cookState.setCookAssistantMessages,
        }}
      />

      {cookState.isCookFinishOpen && cookState.activeCookCard && cookState.cookSession ? (
        <RecipeCookFinishDialog
          recipeTitle={cookState.activeCookCard.recipe.title}
          cookPreview={cookState.cookPreview}
          cookPreviewError={cookState.cookPreviewError}
          isCookPreviewLoading={cookState.isCookPreviewLoading}
          session={cookState.cookSession}
          isCooking={props.isCookingRecipe}
          submitDisabled={cookState.cookSubmitDisabled}
          statusMessage={cookState.cookFinishStatusMessage}
          success={
            cookState.cookCompletionResult
              ? {
                  message: cookState.cookCompletionResult.message,
                  mealLogId: cookState.cookCompletionResult.mealLogId,
                }
              : null
          }
          onUpdateSession={cookState.updateCookSession}
          onClose={() => cookState.setIsCookFinishOpen(false)}
          onSubmit={cookState.submitCookRecipe}
          onFinishAndReturn={() => cookState.dismissCookCompletion()}
          onViewMeal={() => cookState.dismissCookCompletion({ viewMeal: true })}
        />
      ) : null}

      {shopping.shoppingDialogCard ? (
        <RecipeShoppingDialog
          card={shopping.shoppingDialogCard}
          ingredients={props.ingredients}
          drafts={shopping.shoppingDrafts}
          customForm={shopping.shoppingCustomForm}
          isIngredientPickerOpen={shopping.isShoppingIngredientPickerOpen}
          isCreatingShopping={props.isCreatingShopping}
          unitOptions={SHOPPING_UNIT_OPTIONS}
          resolveIngredientImageUrl={resolveIngredientImageUrl}
          onClose={shopping.closeShoppingDialog}
          onUpdateDraft={shopping.updateShoppingDraft}
          onAdjustDraftQuantity={shopping.adjustShoppingDraftQuantity}
          onRemoveDraft={shopping.removeShoppingDraft}
          onAddRecipeIngredient={shopping.addRecipeIngredientToShoppingDraft}
          onChangeCustomForm={shopping.setShoppingCustomForm}
          onSetIngredientPickerOpen={shopping.setIsShoppingIngredientPickerOpen}
          onSelectIngredientOption={shopping.selectShoppingIngredientOption}
          onAdjustCustomQuantity={shopping.adjustCustomShoppingQuantity}
          onAddCustomDraft={shopping.addCustomShoppingDraft}
          onSubmit={() => {
            void shopping.submitShoppingDrafts();
          }}
        />
      ) : null}
    </div>
  );
}

export function EatMealTaskBody(props: {
  mealLog: MealLog;
  foodPlanItems: FoodPlanItem[];
  members: Member[];
  isUpdatingMeal?: boolean;
  updateMealLog: (mealLogId: string, payload: UpdateMealLogPayload) => Promise<unknown>;
  onClose: () => void;
}) {
  const [isEnrichOpen, setIsEnrichOpen] = useState(false);

  return (
    <>
      <WorkspaceOverlayFrame rootClassName="eat-task-body-overlay-root" onClose={props.onClose}>
        <WorkspaceModal
          title="这餐详情"
          description="查看这次餐食的评价、评论和照片。"
          eyebrow="记录"
          className="meal-log-modal meal-log-enrich-modal meal-log-preview-modal"
          onClose={props.onClose}
          footerActions={
            <FormActions
              className="meal-log-preview-modal-actions"
              primaryLabel="编辑这顿"
              onPrimary={() => setIsEnrichOpen(true)}
              secondaryLabel="关闭"
              onSecondary={props.onClose}
            />
          }
        >
          <MealHistorySurface
            mode="detail"
            meal={props.mealLog}
            detailContent={
              <div className="meal-log-preview-detail" data-testid="eat-meal-task-body">
                <div className="meal-enrichment-summary">
                  <span className={`meal-enrichment-meal-pill ${getMealTone(props.mealLog.meal_type)}`}>
                    <span className="meal-log-icon-slot">
                      <MealLogIcon name="done" />
                    </span>
                    {MEAL_TYPE_LABELS[props.mealLog.meal_type]}
                  </span>
                  <strong>{buildMealTitle(props.mealLog)}</strong>
                  <span className="meal-enrichment-summary-divider" />
                  <small>{formatDateTime(props.mealLog.created_at)}</small>
                </div>
                <p className="eat-meal-task-notes">{props.mealLog.notes || '这条记录还没有评论。'}</p>
                <ul className="eat-meal-task-foods">
                  {props.mealLog.food_entries.map((entry) => (
                    <li key={entry.id}>
                      <strong>{entry.food_name || '未命名菜品'}</strong>
                      <span>
                        {entry.rating == null
                          ? '—'
                          : `★ ${entry.rating.toFixed(1).replace(/\.0$/, '')} 分`}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            }
          />
        </WorkspaceModal>
      </WorkspaceOverlayFrame>

      <MealEnrichmentModal
        open={isEnrichOpen}
        meal={props.mealLog}
        members={props.members}
        isUpdating={Boolean(props.isUpdatingMeal)}
        updateMealLog={props.updateMealLog}
        onClose={() => setIsEnrichOpen(false)}
        overlayRootClassName="eat-task-body-overlay-root"
      />
    </>
  );
}

export function EatMealCreateTaskBody(props: {
  food: Food | null;
  planItem: FoodPlanItem | null;
  date?: string;
  mealType?: MealType;
  recipes: Recipe[];
  isSubmitting?: boolean;
  onClose: () => void;
  onSubmit: (payload: QuickAddMealLogPayload) => Promise<unknown>;
}) {
  const food = props.food;
  const [dialog, setDialog] = useState<FoodQuickMealDialogState | null>(() => {
    if (!food) return null;
    // Task 15: FoodQuickMealDialog no longer carries stock fields.
    // Eat still uses quick-add until Task 16; inventory is not coupled here.
    return {
      action: 'eat',
      date: props.date ?? props.planItem?.plan_date ?? todayKey(),
      food,
      mealType: props.mealType ?? props.planItem?.meal_type ?? getDefaultMealType(food),
      recipeId: food.recipe_id ?? undefined,
    };
  });

  if (!food || !dialog) {
    return (
      <WorkspaceOverlayFrame rootClassName="eat-task-body-overlay-root" onClose={props.onClose}>
        <WorkspaceModal title="记录一餐" onClose={props.onClose}>
          <StateBlock
            status="empty"
            title="还没有可记录的家常菜"
            description="请先从发现或菜单选择一份食物，再记录这一餐。"
          />
          <ActionButton tone="primary" type="button" onClick={props.onClose}>
            关闭
          </ActionButton>
        </WorkspaceModal>
      </WorkspaceOverlayFrame>
    );
  }

  const dateOptions = Array.from({ length: 7 }, (_, index) => addDateKeyDays(todayKey(), index));

  return (
    <FoodQuickMealDialog
      dialog={dialog}
      dateOptions={dateOptions}
      isSubmitting={props.isSubmitting}
      recipes={props.recipes}
      onChange={(patch) => {
        setDialog((current) =>
          current
            ? {
                ...current,
                ...patch,
              }
            : current,
        );
      }}
      onClose={props.onClose}
      onSubmit={async (event) => {
        event.preventDefault();

        const payload: QuickAddMealLogPayload = {
          food_id: dialog.food.id,
          date: dialog.date,
          meal_type: dialog.mealType,
          servings: 1,
          note: props.planItem ? '来自菜单记录' : '快捷记录',
          ...(props.planItem ? { food_plan_item_id: props.planItem.id } : {}),
        };

        await props.onSubmit(payload);
        props.onClose();
      }}
    />
  );
}

export function buildEatTaskBodies(args: {
  resolvedTask: ResolvedEatTask;
  recipes: Recipe[];
  foods: Food[];
  ingredients: Ingredient[];
  inventoryItems: InventoryItem[];
  mealLogs: MealLog[];
  foodPlanItems: FoodPlanItem[];
  members: Member[];
  isQuickAdding?: boolean;
  isUpdatingPlan?: boolean;
  isCookingRecipe?: boolean;
  isCreatingShopping?: boolean;
  isSavingFood?: boolean;
  isUpdatingRecipe?: boolean;
  isUpdatingMeal?: boolean;
  cookRecipe: (recipeId: string, payload: CookRecipeRequest) => Promise<CookRecipeResponse>;
  previewCookRecipe: (recipeId: string, payload: CookRecipePreviewRequest) => Promise<CookRecipePreviewResponse>;
  updateFoodPlanItem: (
    itemId: string,
    payload: { plan_date?: string; meal_type?: MealType; note?: string },
  ) => Promise<unknown>;
  deleteFoodPlanItem: (itemId: string) => Promise<unknown>;
  createFoodPlanItem: (payload: {
    food_id: string;
    plan_date: string;
    meal_type: MealType;
    note: string;
  }) => Promise<unknown>;
  updateFood: (foodId: string, payload: UpdateFoodPayload) => Promise<unknown>;
  updateRecipe: (recipeId: string, payload: RecipePayload) => Promise<unknown>;
  updateMealLog: (mealLogId: string, payload: UpdateMealLogPayload) => Promise<unknown>;
  createShoppingItem: (payload: {
    title: string;
    quantity?: number | null;
    unit?: string | null;
    ingredient_id: string;
    quantity_mode?: ShoppingListItem['quantity_mode'];
    display_label?: string | null;
    reason: string;
  }) => Promise<ShoppingListItem>;
  quickAddMeal: (payload: QuickAddMealLogPayload) => Promise<MealLog>;
  onClose: () => void;
  onOpenLogs: () => void;
  onNavigateRecipe: (recipeId: string, mode?: 'view' | 'edit') => void;
  onStartCook: (recipeId: string, foodPlanItemId?: string) => void;
  onStartCookWithFood: (foodId: string, recipeId: string) => void;
  onQuickAdd: (food: Food, mealType: MealType) => void;
  onCookCompleted: () => void;
  onViewMealLog?: (mealLogId: string) => void;
  onCookResumePromptChange?: (open: boolean) => void;
  sessionScope?: { userId: string; familyId: string } | null;
}): {
  foodTaskContent?: ReactNode;
  recipeTaskContent?: ReactNode;
  cookTaskContent?: ReactNode;
  planTaskContent?: ReactNode;
  mealTaskContent?: ReactNode;
  mealCreateContent?: ReactNode;
} {
  const resolved = args.resolvedTask;

  if (resolved.kind === 'food') {
    return {
      foodTaskContent: (
        <EatFoodTaskBody
          food={resolved.food}
          recipes={args.recipes}
          ingredients={args.ingredients}
          inventoryItems={args.inventoryItems}
          mealLogs={args.mealLogs}
          foods={args.foods}
          isQuickAdding={args.isQuickAdding}
          isSavingFood={args.isSavingFood}
          isUpdatingPlan={args.isUpdatingPlan}
          updateFood={args.updateFood}
          createFoodPlanItem={args.createFoodPlanItem}
          onClose={args.onClose}
          onEditRecipe={(food) => {
            if (food.recipe_id) args.onNavigateRecipe(food.recipe_id, 'edit');
          }}
          onOpenLogs={args.onOpenLogs}
          onStartCook={(recipeId) => args.onStartCook(recipeId)}
          onQuickAdd={args.onQuickAdd}
        />
      ),
    };
  }

  if (resolved.kind === 'ready-recipe') {
    return {
      recipeTaskContent: (
        <EatRecipeTaskBody
          foodId={resolved.foodId}
          recipeId={resolved.recipeId}
          mode={resolved.mode}
          recipes={args.recipes}
          foods={args.foods}
          ingredients={args.ingredients}
          inventoryItems={args.inventoryItems}
          mealLogs={args.mealLogs}
          isUpdatingRecipe={args.isUpdatingRecipe}
          updateRecipe={args.updateRecipe}
          onClose={args.onClose}
          onCook={(foodId, recipeId) => args.onStartCookWithFood(foodId, recipeId)}
          onEdit={(recipeId) => args.onNavigateRecipe(recipeId, 'edit')}
        />
      ),
    };
  }

  if (resolved.kind === 'plan') {
    const food = args.foods.find((item) => item.id === resolved.item.food_id) ?? null;
    return {
      planTaskContent: (
        <EatPlanTaskBody
          item={resolved.item}
          food={food}
          recipes={args.recipes}
          isUpdatingPlan={args.isUpdatingPlan}
          isCompleting={args.isQuickAdding || args.isCookingRecipe}
          isUpdatingMeal={args.isUpdatingMeal}
          members={args.members}
          onClose={args.onClose}
          onUpdate={args.updateFoodPlanItem}
          onDelete={args.deleteFoodPlanItem}
          onComplete={(item) =>
            args.quickAddMeal({
                food_id: item.food_id,
                date: item.plan_date,
                meal_type: item.meal_type,
                servings: 1,
                note: item.note || '来自菜单记录',
                food_plan_item_id: item.id,
              })
          }
          updateMealLog={args.updateMealLog}
          onStartCook={args.onStartCook}
        />
      ),
    };
  }

  if (resolved.kind === 'cook') {
    return {
      cookTaskContent: (
        <EatCookTaskBody
          food={resolved.food}
          recipe={resolved.recipe}
          launchContext={resolved.launchContext}
          recipes={args.recipes}
          foods={args.foods}
          ingredients={args.ingredients}
          inventoryItems={args.inventoryItems}
          mealLogs={args.mealLogs}
          isCookingRecipe={args.isCookingRecipe}
          isCreatingShopping={args.isCreatingShopping}
          cookRecipe={args.cookRecipe}
          previewCookRecipe={args.previewCookRecipe}
          createShoppingItem={args.createShoppingItem}
          onClose={args.onClose}
          onCompleted={args.onCookCompleted}
          onViewMealLog={args.onViewMealLog}
          onResumePromptChange={args.onCookResumePromptChange}
          sessionScope={args.sessionScope ?? null}
        />
      ),
    };
  }

  if (resolved.kind === 'meal') {
    return {
      mealTaskContent: (
        <EatMealTaskBody
          mealLog={resolved.mealLog}
          foodPlanItems={args.foodPlanItems}
          members={args.members}
          isUpdatingMeal={args.isUpdatingMeal}
          updateMealLog={args.updateMealLog}
          onClose={args.onClose}
        />
      ),
    };
  }

  if (resolved.kind === 'meal-create') {
    const foodId = resolved.task.foodId ?? resolved.planItem?.food_id;
    const food = foodId ? args.foods.find((item) => item.id === foodId) ?? null : null;
    return {
      mealCreateContent: (
        <EatMealCreateTaskBody
          food={food}
          planItem={resolved.planItem}
          date={resolved.task.date}
          mealType={resolved.task.mealType}
          recipes={args.recipes}
          isSubmitting={args.isQuickAdding}
          onClose={args.onClose}
          onSubmit={args.quickAddMeal}
        />
      ),
    };
  }

  return {};
}
