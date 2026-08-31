import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import type {
  Ingredient,
  InventoryItem,
  MealType,
  Member,
  Recipe,
  RecipePayload,
  ShoppingListItem,
  UpdateFoodPayload,
  } from '../../../api/types/food';
import type {
  CookRecipeRequest,
  CookRecipePreviewRequest,
  CookRecipePreviewResponse,
  CookRecipeResponse,
} from '../../../api/types/recipe';
import type {
  Food,
  FoodPlanItem,
} from '../../../api/types/food';
import type {
  CompleteFoodPlanItemPayload,
  MealLog,
  RecordMealPayload,
  RecordMealResponse,
  RecordMealTarget,
  UpdateMealLogPayload,
} from '../../../api/types/meal';
import type { CookLaunchContext } from '../../../app/appNavigationModel';
import { FoodDetailDrawer } from '../../../components/foods/FoodDetailDrawer';
import { FoodEditorForm } from '../../../components/foods/FoodEditorForm';
import { FoodPlanDetailModal, type FoodPlanDetailFormState } from '../../../components/foods/FoodPlanDetailModal';
import { FoodPlanDialog } from '../../../components/foods/FoodPlanDialog';
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
} from '../../../components/foods/FoodWorkspaceHelpers';
import {
  buildFoodPayloadFromForm,
  foodToForm,
  getFoodFormCompletionItems,
  getFoodImagePayload,
  type FoodFormState,
} from '../../../components/foods/FoodWorkspaceModel';
import { MEAL_OPTIONS } from '../../../components/foods/FoodWorkspaceOptions';
import { RecipeCookFinishDialog } from '../../../components/recipes/RecipeCookFinishDialog';
import { RecipeDetailView } from '../../../components/recipes/RecipeDetailView';
import { RecipeEditorView } from '../../../components/recipes/RecipeEditorView';
import { RecipeShoppingDialog } from '../../../components/recipes/RecipeShoppingDialog';
import { RecipeTaskSurface } from '../../../components/recipes/RecipeTaskSurface';
import {
  buildRecipeImagePayload,
  buildRecipePayload,
  getRecipeDraftGenerationButtonLabel,
  resolveIngredientImageUrl,
} from '../../../components/recipes/RecipeWorkspaceModel';
import { SHOPPING_UNIT_OPTIONS } from '../../../components/recipes/RecipeWorkspaceOptions';
import { useRecipeCookState } from '../../../components/recipes/useRecipeCookState';
import { useRecipeEditorState } from '../../../components/recipes/useRecipeEditorState';
import { useRecipeShoppingState } from '../../../components/recipes/useRecipeShoppingState';
import { buildRecipeCards, type RecipeWorkspaceView } from '../../../components/recipes/workspaceModel';
import {
  ActionButton,
  ConfirmDialog,
  FormActions,
  StateBlock,
  WorkspaceModal,
  WorkspaceOverlayFrame,
} from '../../../components/ui-kit';
import { useImageComposer } from '../../../hooks/useImageComposer';
import { getMediaIds, getPendingImageJobId } from '../../../lib/aiImages';
import { resolveAssetUrl } from '../../../lib/assets';
import { getFoodCover, getFoodCoverAsset, getImagePreview, splitTags, todayKey, formatDateTime, MEAL_TYPE_LABELS } from '../../../lib/ui';
import { MealCandidateSelector } from '../../meals/MealCandidateSelector';
import { MealComposer } from '../../meals/MealComposer';
import {
  buildRecordMealPayload,
  canSubmitWithCandidateResolution,
  createMealBusinessDate,
  createMealRecordDateOptions,
  reconcilePlannedMealFoods,
  type MealCandidateResolution,
  deriveCandidatePresentation,
  type MealComposerFood,
} from '../../meals/MealComposerModel';
import { MealEnrichmentModal } from '../../meals/MealEnrichmentModal';
import { MealQuickRecordView } from '../../meals/MealQuickRecordView';
import { useMealCandidateData } from '../../meals/useMealCandidateData';
import { useMealComposerActions } from '../../meals/useMealComposerActions';
import { useMealComposerData } from '../../meals/useMealComposerData';
import { useMealComposerState } from '../../meals/useMealComposerState';
import {
  extractMealRecordErrorCode,
  messageFromMealRecordReason,
} from '../../meals/mealRecordErrors';
import { buildMealTitle, getMealTone } from '../../meals/MealLogWorkspaceModel';
import { MealLogIcon } from '../../meals/MealLogIcons';
import { MealHistorySurface } from '../../meals/MealHistorySurface';
import type { ResolvedEatTask } from '../EatWorkspaceViewModel';

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
            eyebrow="食物信息"
            className="food-editor-modal"
            busy={Boolean(props.isSavingFood)}
            footerInfo={(
              <>
                <strong>
                  已完成 {completionItems.filter((item) => item.done).length} / {completionItems.length} 项信息
                </strong>
                <span>保存后仍可继续完善</span>
              </>
            )}
            footerActions={(
              <FormActions
                primaryLabel="保存"
                submittingLabel="保存中…"
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
                title: isSelfMade ? '家常菜信息' : '食物信息',
                description: '保存后会更新这份家常菜的基础信息。',
              }}
              editorRecipeCover={recipe?.images[0]?.url}
              editorRecipeMeta={recipe ? `${recipe.ingredient_items.length} 项用料 · ${recipe.steps.length} 步` : '还没有做法'}
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
