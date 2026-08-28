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
} from '../../../api/types/food';
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
    { label: '已添加食材', done: editorIngredientCount > 0 },
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
          <StateBlock status="loading" title="请稍候" description="正在整理做法内容。" />
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
