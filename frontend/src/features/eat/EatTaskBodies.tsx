import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import type {
  CookRecipeRequest,
  CookRecipePreviewResponse,
  CookRecipeResponse,
  Food,
  FoodPlanItem,
  Ingredient,
  InventoryItem,
  MealLog,
  MealType,
  Recipe,
} from '../../api/types';
import type { CookLaunchContext } from '../../app/appNavigationModel';
import { FoodDetailDrawer } from '../../components/foods/FoodDetailDrawer';
import { FoodPlanDetailModal, type FoodPlanDetailFormState } from '../../components/foods/FoodPlanDetailModal';
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
import { MEAL_OPTIONS } from '../../components/foods/FoodWorkspaceOptions';
import { RecipeDetailView } from '../../components/recipes/RecipeDetailView';
import { RecipeTaskSurface } from '../../components/recipes/RecipeTaskSurface';
import { useRecipeCookState } from '../../components/recipes/useRecipeCookState';
import { buildRecipeCards, type RecipeWorkspaceView } from '../../components/recipes/workspaceModel';
import {
  ActionButton,
  FormActions,
  StateBlock,
  WorkspaceModal,
  WorkspaceOverlayFrame,
} from '../../components/ui-kit';
import { getFoodCoverAsset, todayKey, formatDateTime, MEAL_TYPE_LABELS } from '../../lib/ui';
import { resolveAssetUrl } from '../../lib/assets';
import {
  buildMealTitle,
  getMealRecordPresentation,
  getMealTone,
  resolveMealSource,
} from '../meals/MealLogWorkspaceModel';
import { MealLogIcon } from '../meals/MealLogIcons';
import { MealHistorySurface } from '../meals/MealHistorySurface';
import type { ResolvedEatTask } from './EatWorkspaceViewModel';

function resolveUrl(url: string) {
  return resolveAssetUrl(url) ?? url;
}

function addDateDays(dateKey: string, days: number) {
  const [year, month, day] = dateKey.split('-').map(Number);
  const date = new Date(year, (month || 1) - 1, day || 1);
  date.setDate(date.getDate() + days);
  return date.toISOString().slice(0, 10);
}

export function EatFoodTaskBody(props: {
  food: Food;
  recipes: Recipe[];
  ingredients: Ingredient[];
  inventoryItems: InventoryItem[];
  mealLogs: MealLog[];
  foods: Food[];
  isQuickAdding?: boolean;
  onClose: () => void;
  onEdit: (food: Food) => void;
  onEditRecipe: (food: Food) => void;
  onOpenLogs: () => void;
  onOpenPlanDialog: (food: Food) => void;
  onStartCook: (recipeId: string) => void;
  onQuickAdd: (food: Food, mealType: MealType) => void;
}) {
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

  return (
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
      onEdit={props.onEdit}
      onEditRecipe={props.onEditRecipe}
      onOpenLogs={props.onOpenLogs}
      onOpenPlanDialog={props.onOpenPlanDialog}
      onStartCook={props.onStartCook}
      onQuickAdd={props.onQuickAdd}
      resolveAssetUrl={resolveUrl}
      overlayRootClassName="eat-task-body-overlay-root"
    />
  );
}

export function EatPlanTaskBody(props: {
  item: FoodPlanItem;
  food: Food | null;
  recipes: Recipe[];
  isUpdatingPlan?: boolean;
  isCompleting?: boolean;
  onClose: () => void;
  onUpdate: (itemId: string, payload: { plan_date?: string; meal_type?: MealType; note?: string }) => Promise<unknown>;
  onDelete: (itemId: string) => Promise<unknown>;
  onComplete: (item: FoodPlanItem) => void;
  onStartCook?: (recipeId: string, foodPlanItemId: string) => void;
}) {
  const [isEditing, setIsEditing] = useState(false);
  const [form, setForm] = useState<FoodPlanDetailFormState>({
    planDate: props.item.plan_date,
    mealType: props.item.meal_type,
    note: props.item.note ?? '',
  });

  useEffect(() => {
    setIsEditing(false);
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

  return (
    <FoodPlanDetailModal
      item={props.item}
      food={props.food}
      recipes={props.recipes}
      form={form}
      isEditing={isEditing}
      isUpdatingPlan={props.isUpdatingPlan}
      isCompleting={props.isCompleting}
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
        props.onComplete(props.item);
      }}
      onDelete={() => {
        void props.onDelete(props.item.id).then(() => props.onClose());
      }}
      resolveAssetUrl={resolveUrl}
      overlayRootClassName="eat-task-body-overlay-root"
    />
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
  onClose: () => void;
  onCook: (foodId: string, recipeId: string) => void;
  onEdit: (recipeId: string) => void;
}) {
  const cards = useMemo(
    () => buildRecipeCards(props.recipes, props.ingredients, props.inventoryItems, props.mealLogs, props.foods),
    [props.foods, props.ingredients, props.inventoryItems, props.mealLogs, props.recipes],
  );
  const selectedCard = cards.find((card) => card.recipe.id === props.recipeId) ?? null;
  // food is available via cards.linkedFood when needed for relation checks.

  if (!selectedCard) {
    return (
      <WorkspaceOverlayFrame rootClassName="eat-task-body-overlay-root" onClose={props.onClose}>
        <WorkspaceModal title="做法" description="正在加载做法详情。" onClose={props.onClose}>
          <StateBlock status="loading" title="请稍候" description="正在准备做法内容。" />
        </WorkspaceModal>
      </WorkspaceOverlayFrame>
    );
  }

  const selectedReadyCount = selectedCard.ingredientAvailability.filter((item) => item.ready).length;
  const selectedIngredientCount = selectedCard.ingredientAvailability.length;
  const selectedShortageCount = selectedCard.shortages.length;

  return (
    <div className="eat-recipe-task-body" data-testid="eat-recipe-task-body">
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
  cookRecipe: (recipeId: string, payload: CookRecipeRequest) => Promise<CookRecipeResponse>;
  previewCookRecipe: (recipeId: string, payload: CookRecipeRequest) => Promise<CookRecipePreviewResponse>;
  onClose: () => void;
  onCompleted: () => void;
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

  const cookState = useRecipeCookState({
    cards,
    selectedCard,
    view,
    setView,
    setSelectedRecipeId,
    startRecipeId: props.recipe.id,
    startFoodPlanItemId: planItemId,
    startRecipeReturnTarget: null,
    onStartRecipeHandled: () => undefined,
    previewCookRecipe: props.previewCookRecipe,
    cookRecipe: async (recipeId, payload) => {
      const result = await props.cookRecipe(recipeId, payload);
      props.onCompleted();
      return result;
    },
    isCookingRecipe: props.isCookingRecipe,
    showRecipeNotice: () => undefined,
  });

  useEffect(() => {
    if (!cookState.cookSession || launchSeeded) return;
    cookState.updateCookSession({
      date: props.launchContext.date,
      mealType: props.launchContext.mealType,
      servings: String(props.launchContext.servings),
      planItemId,
    });
    setLaunchSeeded(true);
  }, [cookState, cookState.cookSession, launchSeeded, planItemId, props.launchContext]);

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
          exitCookMode: () => props.onClose(),
          cookBackLabel: '关闭',
          cookBackTarget: 'source',
          cookExitTarget: 'source',
          jumpToCookStep: cookState.jumpToCookStep,
          moveCookStep: cookState.moveCookStep,
          completeCurrentCookStepAndContinue: cookState.completeCurrentCookStepAndContinue,
          resetActiveCookSession: cookState.resetActiveCookSession,
          openCookFinishDialog: () => cookState.setIsCookFinishOpen(true),
          openShoppingDialog: () => undefined,
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
    </div>
  );
}

export function EatMealTaskBody(props: {
  mealLog: MealLog;
  foodPlanItems: FoodPlanItem[];
  onClose: () => void;
  onEnrich?: () => void;
}) {
  const source = resolveMealSource(props.mealLog, props.foodPlanItems);
  const presentation = getMealRecordPresentation(props.mealLog);

  return (
    <WorkspaceOverlayFrame rootClassName="eat-task-body-overlay-root" onClose={props.onClose}>
      <WorkspaceModal
        title="这餐详情"
        description="查看这次餐食的来源、评价、评论和照片。"
        eyebrow="记录"
        className="meal-log-modal meal-log-enrich-modal meal-log-preview-modal"
        onClose={props.onClose}
        footerActions={
          <FormActions
            className="meal-log-preview-modal-actions"
            primaryLabel={presentation.enrichment === 'enriched' ? '关闭' : '继续补充'}
            onPrimary={() => {
              if (presentation.enrichment === 'enriched') {
                props.onClose();
                return;
              }
              props.onEnrich?.();
              props.onClose();
            }}
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
                {source ? (
                  <span className="meal-enrichment-source-pill">
                    {source.status === 'planned' ? '来自菜单计划' : '手动补录'}
                  </span>
                ) : null}
              </div>
              <p className="eat-meal-task-notes">{props.mealLog.notes || '这条记录还没有补充评论。'}</p>
              <ul className="eat-meal-task-foods">
                {props.mealLog.food_entries.map((entry) => (
                  <li key={entry.id}>
                    <strong>{entry.food_name || '未命名菜品'}</strong>
                    <span>
                      {entry.rating == null ? '未评分' : `★ ${entry.rating.toFixed(1).replace(/\.0$/, '')} 分`}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          }
        />
      </WorkspaceModal>
    </WorkspaceOverlayFrame>
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
  onSubmit: (payload: {
    food_id: string;
    date: string;
    meal_type: MealType;
    servings: number;
    note: string;
  }) => Promise<unknown>;
}) {
  const food = props.food;
  const [dialog, setDialog] = useState<FoodQuickMealDialogState | null>(() =>
    food
      ? {
          action: 'eat',
          date: props.date ?? props.planItem?.plan_date ?? todayKey(),
          food,
          mealType: props.mealType ?? props.planItem?.meal_type ?? getDefaultMealType(food),
          recipeId: food.recipe_id ?? undefined,
        }
      : null,
  );

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

  const dateOptions = Array.from({ length: 7 }, (_, index) => addDateDays(todayKey(), index));

  return (
    <FoodQuickMealDialog
      dialog={dialog}
      dateOptions={dateOptions}
      isSubmitting={props.isSubmitting}
      recipes={props.recipes}
      onChange={(patch) => setDialog((current) => (current ? { ...current, ...patch } : current))}
      onClose={props.onClose}
      onSubmit={async (event) => {
        event.preventDefault();
        await props.onSubmit({
          food_id: dialog.food.id,
          date: dialog.date,
          meal_type: dialog.mealType,
          servings: 1,
          note: props.planItem ? '来自菜单记录' : '快捷记录',
        });
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
  isQuickAdding?: boolean;
  isUpdatingPlan?: boolean;
  isCookingRecipe?: boolean;
  cookRecipe: (recipeId: string, payload: CookRecipeRequest) => Promise<CookRecipeResponse>;
  previewCookRecipe: (recipeId: string, payload: CookRecipeRequest) => Promise<CookRecipePreviewResponse>;
  updateFoodPlanItem: (
    itemId: string,
    payload: { plan_date?: string; meal_type?: MealType; note?: string },
  ) => Promise<unknown>;
  deleteFoodPlanItem: (itemId: string) => Promise<unknown>;
  quickAddMeal: (payload: {
    food_id: string;
    date: string;
    meal_type: MealType;
    servings: number;
    note: string;
  }) => Promise<unknown>;
  onClose: () => void;
  onOpenLogs: () => void;
  onNavigateFoodEdit: (foodId: string) => void;
  onNavigateRecipe: (recipeId: string, mode?: 'view' | 'edit') => void;
  onOpenPlanDialog: (food: Food) => void;
  onStartCook: (recipeId: string, foodPlanItemId?: string) => void;
  onStartCookWithFood: (foodId: string, recipeId: string) => void;
  onQuickAdd: (food: Food, mealType: MealType) => void;
  onCookCompleted: () => void;
  onMealEnrich?: (mealLogId: string) => void;
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
          onClose={args.onClose}
          onEdit={(food) => args.onNavigateFoodEdit(food.id)}
          onEditRecipe={(food) => {
            if (food.recipe_id) args.onNavigateRecipe(food.recipe_id, 'edit');
            else args.onNavigateFoodEdit(food.id);
          }}
          onOpenLogs={args.onOpenLogs}
          onOpenPlanDialog={args.onOpenPlanDialog}
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
          onClose={args.onClose}
          onUpdate={args.updateFoodPlanItem}
          onDelete={args.deleteFoodPlanItem}
          onComplete={(item) => {
            void args
              .quickAddMeal({
                food_id: item.food_id,
                date: item.plan_date,
                meal_type: item.meal_type,
                servings: 1,
                note: item.note || '来自菜单记录',
              })
              .then(() => args.onClose());
          }}
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
          cookRecipe={args.cookRecipe}
          previewCookRecipe={args.previewCookRecipe}
          onClose={args.onClose}
          onCompleted={args.onCookCompleted}
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
          onClose={args.onClose}
          onEnrich={() => args.onMealEnrich?.(resolved.mealLog.id)}
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
