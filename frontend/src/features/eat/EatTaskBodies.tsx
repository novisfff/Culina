import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import type {
  CompleteFoodPlanItemPayload,
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
  RecordMealPayload,
  RecordMealResponse,
  RecordMealTarget,
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
import {
  buildFoodRelationViewModel,
  describeExpiry,
  getDefaultMealType,
  getFoodAudienceText,
  getFoodFactRows,
  getFoodInventoryConfirmation,
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
import { getFoodCover, getFoodCoverAsset, getImagePreview, splitTags, todayKey, formatDateTime, MEAL_TYPE_LABELS } from '../../lib/ui';
import { MealCandidateSelector } from '../meals/MealCandidateSelector';
import { MealComposer } from '../meals/MealComposer';
import {
  buildRecordMealPayload,
  canSubmitWithCandidateResolution,
  createMealBusinessDate,
  createMealRecordDateOptions,
  reconcilePlannedMealFoods,
  type MealCandidateResolution,
  deriveCandidatePresentation,
  type MealComposerFood,
} from '../meals/MealComposerModel';
import { MealEnrichmentModal } from '../meals/MealEnrichmentModal';
import { MealQuickRecordView } from '../meals/MealQuickRecordView';
import { useMealCandidateData } from '../meals/useMealCandidateData';
import { useMealComposerActions } from '../meals/useMealComposerActions';
import { useMealComposerData } from '../meals/useMealComposerData';
import { useMealComposerState } from '../meals/useMealComposerState';
import {
  extractMealRecordErrorCode,
  messageFromMealRecordReason,
} from '../meals/mealRecordErrors';
import { buildMealTitle, getMealTone } from '../meals/MealLogWorkspaceModel';
import { MealLogIcon } from '../meals/MealLogIcons';
import { MealHistorySurface } from '../meals/MealHistorySurface';
import type { ResolvedEatTask } from './EatWorkspaceViewModel';

const EAT_FOOD_EDITOR_FORM_ID = 'eat-food-editor-form';

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
        inventoryConfirmation={isReadyLikeFood(props.food) ? getFoodInventoryConfirmation(props.food, todayKey()) : null}
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
          busy={Boolean(props.isSavingFood)}
          closeOnBackdrop={!props.isSavingFood}
        >
          <WorkspaceModal
            title="编辑食物"
            description="补充名称、库存和日常信息。"
            eyebrow="食物资料"
            className="food-editor-modal"
            busy={Boolean(props.isSavingFood)}
            footerInfo={(
              <>
                <strong>
                  已完成 {completionItems.filter((item) => item.done).length} / {completionItems.length} 项资料
                </strong>
                <span>保存后仍可继续补充</span>
              </>
            )}
            footerActions={(
              <FormActions
                primaryLabel="保存"
                submittingLabel="保存中..."
                primaryType="submit"
                primaryForm={EAT_FOOD_EDITOR_FORM_ID}
                primaryDisabled={props.isSavingFood || !Boolean(form.name.trim() || isSelfMade)}
                isSubmitting={Boolean(props.isSavingFood)}
                secondaryLabel="取消"
                onSecondary={() => {
                  if (!props.isSavingFood) setIsEditing(false);
                }}
              />
            )}
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
              editorProfile={{
                title: isSelfMade ? '家常菜资料' : '食物资料',
                description: '保存后会更新这份家常菜的基础信息。',
              }}
              editorRecipeCover={recipe?.images[0]?.url}
              editorRecipeMeta={recipe ? `${recipe.ingredient_items.length} 项用料 · ${recipe.steps.length} 步` : '未绑定做法'}
              formId={EAT_FOOD_EDITOR_FORM_ID}
              form={form}
              imageState={imageComposer.state}
              isSavingFood={props.isSavingFood}
              isSceneTagPickerOpen={isSceneTagPickerOpen}
              isSelfMade={isSelfMade}
              isUpdatingScene={false}
              newSceneTagName={newSceneTagName}
              sceneTags={sceneTags}
              showActions={false}
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
  /** Non-recipe plan complete owner (Task 16). Never publishes ordinary record undo. */
  onComplete: (
    item: FoodPlanItem,
    target?: {
      target_meal_log_id?: string | null;
      expected_meal_log_row_version?: number | null;
    },
  ) => Promise<MealLog>;
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

  const needsPlanCompleteCandidates = Boolean(
    props.item && !props.item.recipe_id && props.item.status !== 'cooked',
  );
  const planCandidateQuery = useMealCandidateData({
    open: needsPlanCompleteCandidates,
    date: props.item.plan_date,
    mealType: props.item.meal_type,
  });
  const planCandidates = planCandidateQuery.candidates;
  const planCandidatesFetched = planCandidateQuery.query.isFetched;
  const planCandidateIdsKey = planCandidates
    .map((candidate) => `${candidate.meal_log_id}:${candidate.row_version}`)
    .join(',');
  const [planCompleteTarget, setPlanCompleteTarget] = useState<RecordMealTarget>({ kind: 'new' });
  const [planCompleteSelectedCandidateId, setPlanCompleteSelectedCandidateId] = useState<string | null>(
    null,
  );
  const [planCompleteCandidateMode, setPlanCompleteCandidateMode] = useState<'none' | 'single' | 'multi'>(
    'none',
  );

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

  useEffect(() => {
    if (!needsPlanCompleteCandidates) {
      setPlanCompleteTarget({ kind: 'new' });
      setPlanCompleteSelectedCandidateId(null);
      setPlanCompleteCandidateMode('none');
      return;
    }
    if (!planCandidatesFetched) return;
    const presentation = deriveCandidatePresentation(planCandidates, props.item.meal_type);
    setPlanCompleteTarget(presentation.target);
    setPlanCompleteSelectedCandidateId(presentation.selectedCandidateId);
    setPlanCompleteCandidateMode(presentation.mode);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    needsPlanCompleteCandidates,
    props.item.id,
    props.item.plan_date,
    props.item.meal_type,
    planCandidateIdsKey,
    planCandidatesFetched,
  ]);

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

  const planCompleteDraftFoods: MealComposerFood[] = [
    {
      kind: 'existing',
      food_id: props.item.food_id,
      name: props.item.food_name,
      servings: 1,
      cover: null,
    },
  ];

  const planCompleteExtras =
    needsPlanCompleteCandidates ? (
      <MealCandidateSelector
        mode={planCompleteCandidateMode}
        mealType={props.item.meal_type}
        candidates={planCandidates}
        selectedCandidateId={planCompleteSelectedCandidateId}
        target={planCompleteTarget}
        draftFoods={planCompleteDraftFoods}
        disabled={props.isCompleting}
        className="eat-plan-detail-candidates"
        onTargetChange={(target, selectedCandidateId) => {
          setPlanCompleteTarget(target);
          setPlanCompleteSelectedCandidateId(selectedCandidateId ?? null);
        }}
      />
    ) : null;

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
      completeExtras={planCompleteExtras}
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
        const target =
          planCompleteTarget.kind === 'existing'
            ? {
                target_meal_log_id: planCompleteTarget.meal_log_id,
                expected_meal_log_row_version: planCompleteTarget.expected_row_version,
              }
            : undefined;
        void props
          .onComplete(props.item, target)
          .then((meal) => {
            if (activeItemIdRef.current === completingItemId && completionRequestRef.current === requestId) {
              setRecordedMeal(meal);
            }
          })
          .catch((reason) => {
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
          selectedRecentCookLog={selectedCard.recipe.cook_logs[0] ?? null}
          selectedRecipePlanItems={[]}
          showPlanAction={false}
          showShoppingAction={false}
          showEditAction
          showDeleteAction={false}
          compactHeader
          showHeroTitle={false}
          backLabel="关闭"
          onBack={props.onClose}
          onCook={() => props.onCook(props.foodId, props.recipeId)}
          onPlan={() => undefined}
          onShopping={() => undefined}
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
          recipeCover={cookState.activeCookCard.recipe.images[0] ?? props.food.images?.[0] ?? null}
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
          candidates={cookState.cookCandidates}
          candidateMode={cookState.cookCandidateMode}
          selectedCandidateId={cookState.cookSelectedCandidateId}
          target={cookState.cookTarget}
          targetNeedsReconfirm={cookState.cookTargetNeedsReconfirm}
          onTargetChange={cookState.setCookMealTarget}
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

/**
 * History free multi-Food recording via production MealComposer + shared hooks.
 * Used when meal-create has no prefilled Food (history “记一餐”).
 *
 * Accidental close keeps draft + request identity in composer state; only success
 * (or explicit discard) should leave the meal-create task shell.
 */
function EatFreeMealComposerBody(props: {
  date?: string;
  mealType?: MealType;
  foods: Food[];
  foodPlanItems: FoodPlanItem[];
  isSubmitting?: boolean;
  recordMeal: (payload: RecordMealPayload) => Promise<RecordMealResponse>;
  onRecordSuccess?: (response: RecordMealResponse) => void;
  onClose: () => void;
}) {
  const businessToday = createMealBusinessDate();
  const [searchQuery, setSearchQuery] = useState('');
  const state = useMealComposerState({
    mode: 'full',
    initialMealType: props.mealType,
  });
  const data = useMealComposerData({
    open: state.open,
    date: state.date,
    mealType: state.mealType,
    searchQuery,
  });
  const plannedFoodSeeds = useMemo(
    () =>
      props.foodPlanItems
        .filter(
          (item) =>
            item.status === 'planned' &&
            item.plan_date === state.date &&
            item.meal_type === state.mealType,
        )
        .map((item) => {
          const food = props.foods.find((candidate) => candidate.id === item.food_id);
          return {
            id: item.id,
            foodId: item.food_id,
            foodName: item.food_name || food?.name || '未命名食物',
            baseUpdatedAt: item.updated_at,
            cover: food?.images[0] ?? null,
          };
        }),
    [props.foodPlanItems, props.foods, state.date, state.mealType],
  );
  const plannedFoodSeedsKey = plannedFoodSeeds
    .map((item) => `${item.id}:${item.baseUpdatedAt}:${item.foodId}`)
    .join(',');
  const plannedFoodRefsByFoodId = useMemo(() => {
    const result: Record<string, Array<{ id: string; baseUpdatedAt: string }>> = {};
    for (const item of plannedFoodSeeds) {
      (result[item.foodId] ??= []).push({ id: item.id, baseUpdatedAt: item.baseUpdatedAt });
    }
    return result;
  }, [plannedFoodSeeds]);

  const candidateResolution = useMemo((): MealCandidateResolution => {
    if (!state.open) return { status: 'idle' };
    if (data.candidateError) {
      return {
        status: 'error',
        message:
          data.candidateError instanceof Error && data.candidateError.message.trim()
            ? data.candidateError.message
            : '加载候选失败，请重试',
      };
    }
    if (data.isLoadingCandidates || data.isFetchingCandidates) {
      return { status: 'loading' };
    }
    // Query settled (success or disabled with empty) — treat as ready for this slot.
    return { status: 'ready' };
  }, [
    data.candidateError,
    data.isFetchingCandidates,
    data.isLoadingCandidates,
    state.open,
  ]);

  const actions = useMealComposerActions({
    state,
    candidates: data.candidates,
    candidateResolution,
    refetchCandidates: data.refetchCandidates,
    recordMeal: props.recordMeal,
    // App-level recordMeal mutation already invalidates caches on success.
    invalidateAfterRecord: async () => undefined,
    publishRecordResult: (response) => {
      props.onRecordSuccess?.(response);
      // Success leaves the meal-create shell.
      props.onClose();
    },
  });

  // Open once with nav-provided date / mealType (history CTA).
  const openedRef = useRef(false);
  useEffect(() => {
    if (openedRef.current) return;
    openedRef.current = true;
    state.openComposer({
      date: props.date ?? businessToday,
      mealType: props.mealType,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!state.open) return;
    state.setFoods((current) => reconcilePlannedMealFoods(current, plannedFoodSeeds));
    // Reconcile only when the authoritative plan set for the selected slot changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.open, state.date, state.mealType, plannedFoodSeedsKey]);

  const candidateIdsKey = data.candidates
    .map((candidate) => `${candidate.meal_log_id}:${candidate.row_version}`)
    .join(',');
  useEffect(() => {
    if (!state.open || state.requiresTargetReconfirm) return;
    if (candidateResolution.status !== 'ready') return;
    // applyCandidates preserves user-chosen target unless force.
    state.applyCandidates(data.candidates);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.open, state.date, state.mealType, candidateIdsKey, candidateResolution.status]);

  const dateOptions = useMemo(() => createMealRecordDateOptions(businessToday), [businessToday]);

  const candidatesBusy = candidateResolution.status === 'loading';
  const submitBlocked =
    candidatesBusy ||
    candidateResolution.status === 'error' ||
    state.requiresTargetReconfirm;

  return (
    <MealComposer
      open={state.open}
      date={state.date}
      mealType={state.mealType}
      dateOptions={dateOptions}
      foods={state.foods}
      candidates={data.candidates}
      selectedCandidateId={state.selectedCandidateId}
      candidateMode={state.candidateMode}
      target={state.target}
      searchQuery={searchQuery}
      searchResults={data.foods}
      isSearchingFoods={data.isSearchingFoods}
      busy={state.busy || Boolean(props.isSubmitting)}
      submitDisabled={submitBlocked}
      candidateSelectionDisabled={candidatesBusy || candidateResolution.status === 'error'}
      error={
        state.error ??
        (candidateResolution.status === 'error' ? candidateResolution.message : null) ??
        (candidatesBusy ? '正在确认是否有可加入的餐食…' : null)
      }
      plannedFoodRefsByFoodId={plannedFoodRefsByFoodId}
      overlayRootClassName="eat-task-body-overlay-root"
      onClose={() => {
        if (state.busy) return;
        // Accidental close: keep draft + request id; stay on meal-create surface.
        state.close();
      }}
      onDateChange={state.setDate}
      onMealTypeChange={state.setMealType}
      onSearchQueryChange={setSearchQuery}
      onFoodsChange={state.setFoods}
      onTargetChange={state.setTarget}
      onSubmit={() => {
        void actions.submitRecord();
      }}
    />
  );
}

/** Compact prefilled single-Food record (Food / plan complete). */
function EatPrefixedMealCreateBody(props: {
  food: Food | null;
  planItem: FoodPlanItem | null;
  date?: string;
  mealType?: MealType;
  recipes: Recipe[];
  isSubmitting?: boolean;
  isCompletingPlan?: boolean;
  recordMeal: (payload: RecordMealPayload) => Promise<RecordMealResponse>;
  completeFoodPlanItem: (itemId: string, payload: CompleteFoodPlanItemPayload) => Promise<MealLog>;
  onRecordSuccess?: (response: RecordMealResponse) => void;
  onStartCook?: (recipeId: string, foodPlanItemId?: string) => void;
  onClose: () => void;
}) {
  const food = props.food;
  const planItem = props.planItem;
  // Plan-sourced complete always records on the plan slot (backend enforces plan_date/meal_type).
  const slotLocked = Boolean(planItem);
  const businessToday = createMealBusinessDate();
  const initialDate = planItem?.plan_date ?? props.date ?? businessToday;
  const initialMealType =
    planItem?.meal_type ?? props.mealType ?? (food ? getDefaultMealType(food) : 'dinner');

  const [date, setDate] = useState(initialDate);
  const [mealType, setMealType] = useState<MealType>(initialMealType);
  const [target, setTarget] = useState<RecordMealTarget>({ kind: 'new' });
  const [selectedCandidateId, setSelectedCandidateId] = useState<string | null>(null);
  const [candidateMode, setCandidateMode] = useState<'none' | 'single' | 'multi'>('none');
  const [targetTouchedByUser, setTargetTouchedByUser] = useState(false);
  const [clientRequestId, setClientRequestId] = useState(
    () => `eat-record-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Keep local slot state pinned when planItem is present (or planItem identity changes).
  useEffect(() => {
    if (!planItem) return;
    setDate(planItem.plan_date);
    setMealType(planItem.meal_type);
    setTarget({ kind: 'new' });
    setSelectedCandidateId(null);
    setCandidateMode('none');
    setTargetTouchedByUser(false);
  }, [planItem?.id, planItem?.plan_date, planItem?.meal_type]);

  // Recipe + plan source opens cook owner instead of ordinary record.
  useEffect(() => {
    if (!food) return;
    if (planItem?.recipe_id && props.onStartCook) {
      props.onStartCook(planItem.recipe_id, planItem.id);
      props.onClose();
      return;
    }
    if (!planItem && food.recipe_id && normalizeFoodType(food) === 'selfMade' && props.onStartCook) {
      // Direct meal-create for a recipe food still records as ordinary food unless cook was requested.
      // Keep ordinary record path for explicit meal-create navigation.
    }
  }, [food, planItem, props]);

  // Candidates always follow the effective (locked-when-plan) slot — same pattern as EatPlanTaskBody.
  const effectiveDate = planItem?.plan_date ?? date;
  const effectiveMealType = planItem?.meal_type ?? mealType;
  const needsCandidates = Boolean(food) && !planItem?.recipe_id;
  const candidateQuery = useMealCandidateData({
    open: needsCandidates,
    date: effectiveDate,
    mealType: effectiveMealType,
  });
  const candidates = candidateQuery.candidates;
  const candidatesFetched = candidateQuery.query.isFetched;
  const candidateIdsKey = candidates
    .map((candidate) => `${candidate.meal_log_id}:${candidate.row_version}`)
    .join(',');

  const candidateResolution = useMemo((): MealCandidateResolution => {
    if (!needsCandidates) return { status: 'ready' };
    if (candidateQuery.error) {
      return {
        status: 'error',
        message:
          candidateQuery.error instanceof Error && candidateQuery.error.message.trim()
            ? candidateQuery.error.message
            : '加载候选失败，请重试',
      };
    }
    if (candidateQuery.isLoading || candidateQuery.isFetching || !candidatesFetched) {
      return { status: 'loading' };
    }
    return { status: 'ready' };
  }, [
    candidateQuery.error,
    candidateQuery.isFetching,
    candidateQuery.isLoading,
    candidatesFetched,
    needsCandidates,
  ]);

  useEffect(() => {
    if (!needsCandidates || candidateResolution.status !== 'ready') return;
    const presentation = deriveCandidatePresentation(candidates, effectiveMealType);
    setCandidateMode(presentation.mode);
    if (!targetTouchedByUser) {
      setTarget(presentation.target);
      setSelectedCandidateId(presentation.selectedCandidateId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    needsCandidates,
    effectiveDate,
    effectiveMealType,
    candidateIdsKey,
    candidateResolution.status,
    targetTouchedByUser,
  ]);

  // Plan without food is invalid after free-composer branch; show empty only as last resort.
  if (!food) {
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

  // Plan-origin with recipe is handled by cook effect above; show nothing while redirecting.
  if (planItem?.recipe_id) {
    return null;
  }

  const dateOptions = slotLocked
    ? [effectiveDate]
    : createMealRecordDateOptions(businessToday);
  const cover = getFoodCoverAsset(food, props.recipes) ?? null;
  const candidatesPending = needsCandidates && !canSubmitWithCandidateResolution(candidateResolution);
  const mutationBusy =
    busy ||
    Boolean(props.isSubmitting) ||
    Boolean(props.isCompletingPlan);
  const isBusy = mutationBusy || candidatesPending;

  async function handleSubmit() {
    if (!food || isBusy) return;
    setError(null);

    if (needsCandidates && !canSubmitWithCandidateResolution(candidateResolution)) {
      if (candidateResolution.status === 'error') {
        setError(candidateResolution.message);
      } else {
        setError('正在确认是否有可加入的餐食…');
      }
      return;
    }

    // Plan complete is a separate owner command (never ordinary record undo / never publish record result).
    if (planItem) {
      setBusy(true);
      try {
        const payload: CompleteFoodPlanItemPayload = {
          food_plan_item_base_updated_at: planItem.updated_at,
          ...(target.kind === 'existing'
            ? {
                target_meal_log_id: target.meal_log_id,
                expected_meal_log_row_version: target.expected_row_version,
              }
            : {}),
        };
        await props.completeFoodPlanItem(planItem.id, payload);
        props.onClose();
      } catch (reason) {
        setError(resolveErrorMessage(reason, '完成菜单计划失败，请稍后重试。'));
        setBusy(false);
      }
      return;
    }

    let payload: RecordMealPayload;
    try {
      payload = buildRecordMealPayload({
        clientRequestId,
        date: effectiveDate,
        mealType: effectiveMealType,
        target,
        foods: [
          {
            kind: 'existing',
            food_id: food.id,
            name: food.name,
            servings: 1,
            cover,
          },
        ],
      });
    } catch (reason) {
      setError(resolveErrorMessage(reason, '记录失败，请重试'));
      return;
    }

    setBusy(true);
    try {
      const response = await props.recordMeal(payload);
      props.onRecordSuccess?.(response);
      props.onClose();
    } catch (reason) {
      const code = extractMealRecordErrorCode(reason);
      if (code === 'meal_log_stale') {
        try {
          const refreshed = await candidateQuery.refetch();
          const nextCandidates = Array.isArray(refreshed.data) ? refreshed.data : [];
          const presentation = deriveCandidatePresentation(nextCandidates, effectiveMealType);
          setTarget(presentation.target);
          setSelectedCandidateId(presentation.selectedCandidateId);
          setCandidateMode(presentation.mode);
          setTargetTouchedByUser(false);
          setError('这顿饭刚被家人更新，请重新确认');
        } catch {
          setError(messageFromMealRecordReason(reason, '这顿饭刚被家人更新，请重新确认'));
        }
        setBusy(false);
        return;
      }
      if (code === 'idempotency_key_reused' || code === 'record_operation_reverted') {
        setClientRequestId(`eat-record-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`);
        setError(
          code === 'record_operation_reverted'
            ? '上次记录已撤销，请再试一次'
            : '记录内容已变化，请再试一次',
        );
        setBusy(false);
        return;
      }
      setError(messageFromMealRecordReason(reason, '记录失败，请重试'));
      setBusy(false);
    }
  }

  return (
    <MealQuickRecordView
      open
      prefilledFood={{
        food_id: food.id,
        name: food.name,
        cover,
        servings: 1,
      }}
      date={effectiveDate}
      mealType={effectiveMealType}
      dateOptions={dateOptions}
      candidates={candidates}
      selectedCandidateId={selectedCandidateId}
      candidateMode={candidateMode}
      target={target}
      busy={mutationBusy}
      submitDisabled={candidatesPending}
      error={error}
      slotLocked={slotLocked}
      overlayRootClassName="eat-task-body-overlay-root"
      onClose={props.onClose}
      onDateChange={(next) => {
        if (slotLocked) return;
        setDate(next);
        setTarget({ kind: 'new' });
        setSelectedCandidateId(null);
        setCandidateMode('none');
        setTargetTouchedByUser(false);
      }}
      onMealTypeChange={(next) => {
        if (slotLocked) return;
        setMealType(next);
        setTarget({ kind: 'new' });
        setSelectedCandidateId(null);
        setCandidateMode('none');
        setTargetTouchedByUser(false);
      }}
      onTargetChange={(nextTarget, nextSelectedId) => {
        setTarget(nextTarget);
        setSelectedCandidateId(nextSelectedId ?? null);
        setTargetTouchedByUser(true);
      }}
      onSubmit={() => {
        void handleSubmit();
      }}
    />
  );
}

/** Ordinary Food record via compact MealQuickRecordView + recordMeal (Task 16). */
export function EatMealCreateTaskBody(props: {
  food: Food | null;
  planItem: FoodPlanItem | null;
  date?: string;
  mealType?: MealType;
  recipes: Recipe[];
  foods?: Food[];
  foodPlanItems?: FoodPlanItem[];
  isSubmitting?: boolean;
  isCompletingPlan?: boolean;
  recordMeal: (payload: RecordMealPayload) => Promise<RecordMealResponse>;
  completeFoodPlanItem: (itemId: string, payload: CompleteFoodPlanItemPayload) => Promise<MealLog>;
  onRecordSuccess?: (response: RecordMealResponse) => void;
  onStartCook?: (recipeId: string, foodPlanItemId?: string) => void;
  onClose: () => void;
}) {
  // History free multi-Food recording (no prefilled Food, no plan).
  if (!props.food && !props.planItem) {
    return (
      <EatFreeMealComposerBody
        date={props.date}
        mealType={props.mealType}
        foods={props.foods ?? []}
        foodPlanItems={props.foodPlanItems ?? []}
        isSubmitting={props.isSubmitting}
        recordMeal={props.recordMeal}
        onRecordSuccess={props.onRecordSuccess}
        onClose={props.onClose}
      />
    );
  }

  return <EatPrefixedMealCreateBody {...props} />;
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
  isRecordingMeal?: boolean;
  isCompletingPlan?: boolean;
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
  recordMeal: (payload: RecordMealPayload) => Promise<RecordMealResponse>;
  completeFoodPlanItem: (itemId: string, payload: CompleteFoodPlanItemPayload) => Promise<MealLog>;
  onRecordSuccess?: (response: RecordMealResponse) => void;
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
          isQuickAdding={args.isRecordingMeal}
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
          isCompleting={args.isCompletingPlan || args.isCookingRecipe}
          isUpdatingMeal={args.isUpdatingMeal}
          members={args.members}
          onClose={args.onClose}
          onUpdate={args.updateFoodPlanItem}
          onDelete={args.deleteFoodPlanItem}
          onComplete={async (item, target) => {
            // Recipe plan opens cook; non-recipe uses completeFoodPlanItem.
            // Never publishes ordinary record undo (caller may open enrichment).
            const payload: CompleteFoodPlanItemPayload = {
              food_plan_item_base_updated_at: item.updated_at,
              ...(target?.target_meal_log_id
                ? {
                    target_meal_log_id: target.target_meal_log_id,
                    expected_meal_log_row_version: target.expected_meal_log_row_version ?? null,
                  }
                : {}),
            };
            return args.completeFoodPlanItem(item.id, payload);
          }}
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
          foods={args.foods}
          foodPlanItems={args.foodPlanItems}
          isSubmitting={args.isRecordingMeal}
          isCompletingPlan={args.isCompletingPlan}
          recordMeal={args.recordMeal}
          completeFoodPlanItem={args.completeFoodPlanItem}
          onRecordSuccess={args.onRecordSuccess}
          onStartCook={args.onStartCook}
          onClose={args.onClose}
        />
      ),
    };
  }

  return {};
}
