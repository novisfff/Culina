import { useMemo, useState, type FormEvent, type KeyboardEvent, type ReactNode } from 'react';
import type { Food, FoodPlanItem, FoodRecommendations, Ingredient, InventoryItem, MealLog, MealType, Recipe, ShoppingListItem } from '../../api/types';
import type { AppNavigationTarget } from '../../app/appNavigationModel';
import type { HomePlanCookArgs, HomeRecommendedCookArgs } from '../../app/useAppHomeHandlers';
import { DashboardIcon } from '../../app/shellIcons';
import { MediaWithPlaceholder } from '../../components/MediaPlaceholder';
import {
  Badge,
  EmptyState,
  PageHeader,
  WorkspaceModal,
  WorkspaceOverlayFrame,
} from '../../components/ui-kit';
import { FoodQuickMealDialog, type FoodQuickMealDialogState } from '../../components/foods/FoodQuickMealDialog';
import { MEAL_OPTIONS } from '../../components/foods/FoodWorkspaceOptions';
import { FoodDetailDrawer } from '../../components/foods/FoodDetailDrawer';
import {
  normalizeFoodType,
  isReadyLikeFood,
  isOutsideFood,
  getFoodSceneTags,
  describeExpiry,
  getFoodStatus,
  getFoodFactRows,
  getFoodMealHistory,
  getFoodAudienceText,
  getMealUsage,
  getDefaultMealType,
  getPrimaryFoodActionLabel,
  getRepurchaseLabel,
  getSecondaryFoodActionLabel,
  buildFoodRelationViewModel,
} from '../../components/foods/FoodWorkspaceHelpers';
import { addDateKeyDays } from '../../lib/date';
import { FOOD_TYPE_LABELS, formatDate, getFoodCover, getFoodCoverAsset, MEAL_TYPE_LABELS, todayKey } from '../../lib/ui';
import type {
  InventoryActionGroup,
} from '../inventory/inventoryActionModel';
import {
  type DashboardPlanDay,
  type DashboardPlanSummaryItem,
  type DashboardRecommendation,
  type DashboardStat,
  type HomeHighlightsViewModel,
  type HomeRequiredAction,
} from './homeDashboardModel';
import { HomeCompactCalendar } from './HomeCompactCalendar';
import { HomeHighlightTimeline } from './HomeHighlightTimeline';
import { HomeMobileDashboard } from './HomeMobileDashboard';
import { HomeRequiredActions } from './HomeRequiredActions';

export type HomeDashboardProps = {
  sidebarFamilyName: string;
  sidebarMotto: string;
  sidebarLocation: string;
  sidebarMemberLabel: string;
  sidebarActivityLabel: string;
  inventoryAlerts: unknown[];
  notificationCenter?: ReactNode;
  dashboardStats: DashboardStat[];
  desktopRecommendations: DashboardRecommendation[];
  mobileRecommendations: DashboardRecommendation[];
  recommendationCount: number;
  foodRecommendations?: FoodRecommendations | null;
  homeInventoryActionGroups: InventoryActionGroup[];
  hasLaterInventoryActionGroups: boolean;
  hasFullListInventoryActionGroups: boolean;
  requiredActions: HomeRequiredAction[];
  hasMoreHomeActions: boolean;
  activeFoodPlanItems: FoodPlanItem[];
  foodPlanItems: FoodPlanItem[];
  dashboardWeekMealCapacity: number;
  dashboardPlanDays: DashboardPlanDay[];
  compactPlanDays: DashboardPlanDay[];
  selectedDashboardPlanDay?: DashboardPlanDay;
  selectedDashboardPlanDateLabel: string;
  selectedPlanSummary: string;
  pendingShoppingCount: number;
  pendingShoppingPreview: ShoppingListItem[];
  dashboardPlanSummary: DashboardPlanSummaryItem[];
  foodPlanWeekRange: { start: string; end: string };
  homeHighlights: HomeHighlightsViewModel;
  foods: Food[];
  recipes: Recipe[];
  ingredients: Ingredient[];
  mealLogs: MealLog[];
  inventoryItems: InventoryItem[];
  isQuickAdding: boolean;
  isCreatingFoodPlanItem: boolean;
  resolveAssetUrl: (url?: string) => string | undefined;
  quickAddMeal: (payload: { food_id: string; date: string; meal_type: MealType; servings: number; note: string }) => Promise<unknown>;
  createFoodPlanItem: (payload: { food_id: string; plan_date: string; meal_type: MealType; note: string }) => Promise<FoodPlanItem>;
  onNavigate: (target: AppNavigationTarget) => void;
  onOpenGlobalSearch: () => void;
  onNextDesktopRecommendations: () => void;
  onNextMobileRecommendation: () => void;
  /** Direct cook from recommendation/detail — never creates a plan item. */
  onStartRecommendedRecipe: (input: HomeRecommendedCookArgs) => void;
  /** Plan cook after creating or opening a plan item. */
  onStartPlanRecipe: (input: HomePlanCookArgs) => void;
  onSelectedPlanDateChange: (date: string) => void;
  onHomePlanAddDialogOpen: (food: Food, fallbackMealType?: MealType) => void;
  onHomePlanAddEmptyDialogOpen: (planDate: string, mealType: MealType) => void;
  onHomePlanDetailOpen: (item: FoodPlanItem) => void;
  onHomeRestockOpen: (item: ShoppingListItem) => void;
  onOpenActionGroup: (group: InventoryActionGroup) => void;
  onOpenIngredientShopping: (ingredientId: string) => void;
  onOpenIngredientPriority: () => void;
  onOpenShoppingIntake: () => void;
  onOpenFamilyActivity: () => void;
  onOpenFullWeek: (planDate: string) => void;
  onRetryHighlights: () => void;
  /** Optional: open inventory reconciliation, typically with scope=suggested for long-unconfirmed. */
  onOpenReconciliation?: (args?: { scope?: 'suggested' | 'refrigerated' | 'frozen' | 'room_temperature' | 'all' }) => void;
  onFoodPlanPreviousWeek: () => void;
  onFoodPlanCurrentWeek: () => void;
  onFoodPlanNextWeek: () => void;
};

function getSuggestedHomeMealType(hour = new Date().getHours()): MealType {
  if (hour < 10) return 'breakfast';
  if (hour < 15) return 'lunch';
  if (hour < 22) return 'dinner';
  return 'snack';
}

function getHomeQuickDefaultMealType(food: Food, fallbackMealType?: MealType): MealType {
  const suggestedMealType = fallbackMealType ?? getSuggestedHomeMealType();
  if (food.suitable_meal_types.includes(suggestedMealType)) return suggestedMealType;
  if (food.suitable_meal_types.length === 0) return suggestedMealType;
  return food.suitable_meal_types[0] ?? suggestedMealType;
}

export function HomeDashboard(props: HomeDashboardProps) {
  const {
    sidebarFamilyName,
    sidebarMotto,
    sidebarLocation,
    sidebarMemberLabel,
    sidebarActivityLabel,
    inventoryAlerts,
    dashboardStats,
    desktopRecommendations,
    mobileRecommendations,
    recommendationCount,
    foodRecommendations,
    requiredActions,
    hasMoreHomeActions,
    compactPlanDays,
    selectedDashboardPlanDay,
    selectedPlanSummary,
    foods,
    recipes,
    ingredients,
    mealLogs,
    inventoryItems,
    homeHighlights,
    isQuickAdding,
    isCreatingFoodPlanItem,
    resolveAssetUrl,
    quickAddMeal,
    createFoodPlanItem,
    onNavigate,
    onOpenGlobalSearch,
    onNextDesktopRecommendations,
    onNextMobileRecommendation,
    onStartRecommendedRecipe,
    onStartPlanRecipe,
    onSelectedPlanDateChange,
    onHomePlanAddDialogOpen: openHomePlanAddDialog,
    onHomePlanAddEmptyDialogOpen: openHomePlanAddEmptyDialog,
    onHomePlanDetailOpen: openHomePlanDetail,
    onOpenActionGroup,
    onOpenIngredientShopping,
    onOpenIngredientPriority,
    onOpenShoppingIntake,
    onOpenFamilyActivity,
    onOpenFullWeek,
    onRetryHighlights,
    onOpenReconciliation,
    onFoodPlanPreviousWeek,
    onFoodPlanCurrentWeek,
    onFoodPlanNextWeek,
  } = props;
  const [quickMealDialog, setQuickMealDialog] = useState<FoodQuickMealDialogState | null>(null);
  const [detailFood, setDetailFood] = useState<Food | null>(null);
  const [morePlansPopover, setMorePlansPopover] = useState<{
    date: string;
    mealType: MealType;
    items: FoodPlanItem[];
  } | null>(null);

  function openDetail(food: Food) {
    setDetailFood(food);
  }

  function handleRecommendationCardKeyDown(event: KeyboardEvent<HTMLElement>, food: Food) {
    if (event.target !== event.currentTarget) return;
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    openDetail(food);
  }

  const quickMealDateOptions = useMemo(
    () => Array.from({ length: 7 }, (_, index) => addDateKeyDays(todayKey(), index)),
    [],
  );

  function openQuickMealDialog(food: Food, fallbackMealType?: MealType) {
    setQuickMealDialog({
      action: food.recipe_id ? 'cook' : 'eat',
      date: todayKey(),
      food,
      mealType: getHomeQuickDefaultMealType(food, fallbackMealType),
      recipeId: food.recipe_id ?? undefined,
    });
  }

  function updateQuickMealDialog(patch: Partial<Pick<FoodQuickMealDialogState, 'date' | 'mealType'>>) {
    setQuickMealDialog((current) => (current ? { ...current, ...patch } : current));
  }

  async function submitQuickMealDialog(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!quickMealDialog) return;
    const current = quickMealDialog;
    // Cook path: direct cook without creating a plan item (matches recommendation detail).
    if ((current.action === 'cook' || current.food.recipe_id) && current.food.recipe_id) {
      setQuickMealDialog(null);
      onStartRecommendedRecipe({
        foodId: current.food.id,
        recipeId: current.food.recipe_id,
        date: current.date,
        mealType: current.mealType,
        servings: 1,
      });
      return;
    }
    await quickAddMeal({
      food_id: current.food.id,
      date: current.date,
      meal_type: current.mealType,
      servings: 1,
      note: '首页快捷记录',
    });
    setQuickMealDialog(null);
  }

  function handleOpenInventoryAction(group: InventoryActionGroup) {
    if (group.kind === 'low_stock') {
      onOpenIngredientShopping(group.ingredientId);
      return;
    }
    onOpenActionGroup(group);
  }

  const selectedPlanDate = selectedDashboardPlanDay?.date ?? compactPlanDays[0]?.date ?? '';

  return (
    <>
      <HomeMobileDashboard
        sidebarFamilyName={sidebarFamilyName}
        sidebarMotto={sidebarMotto}
        sidebarLocation={sidebarLocation}
        sidebarMemberLabel={sidebarMemberLabel}
        sidebarActivityLabel={sidebarActivityLabel}
        inventoryAlerts={inventoryAlerts}
        notificationCenter={props.notificationCenter}
        dashboardStats={dashboardStats}
        mobileRecommendations={mobileRecommendations}
        recommendationCount={recommendationCount}
        foodRecommendations={foodRecommendations}
        requiredActions={requiredActions}
        hasMoreHomeActions={hasMoreHomeActions}
        compactPlanDays={compactPlanDays}
        selectedDashboardPlanDay={selectedDashboardPlanDay}
        selectedPlanSummary={selectedPlanSummary}
        homeHighlights={homeHighlights}
        isQuickAdding={isQuickAdding}
        isCreatingFoodPlanItem={isCreatingFoodPlanItem}
        resolveAssetUrl={resolveAssetUrl}
        onNavigate={onNavigate}
        onOpenGlobalSearch={onOpenGlobalSearch}
        onNextMobileRecommendation={onNextMobileRecommendation}
        onSelectedPlanDateChange={onSelectedPlanDateChange}
        onFoodPlanPreviousWeek={onFoodPlanPreviousWeek}
        onFoodPlanCurrentWeek={onFoodPlanCurrentWeek}
        onFoodPlanNextWeek={onFoodPlanNextWeek}
        onQuickStartFood={openQuickMealDialog}
        onHomePlanAddDialogOpen={openHomePlanAddDialog}
        onOpenActionGroup={onOpenActionGroup}
        onOpenIngredientShopping={onOpenIngredientShopping}
        onOpenIngredientPriority={onOpenIngredientPriority}
        onOpenShoppingIntake={onOpenShoppingIntake}
        onOpenFamilyActivity={onOpenFamilyActivity}
        onOpenFullWeek={onOpenFullWeek}
        onRetryHighlights={onRetryHighlights}
        onOpenDetail={openDetail}
        onOpenReconciliation={onOpenReconciliation}
      />

      {quickMealDialog && (() => {
        const isCookAction = quickMealDialog.action === 'cook' && quickMealDialog.recipeId;
        const isSubmitting = Boolean(isQuickAdding || (isCookAction && isCreatingFoodPlanItem));

        return (
          <FoodQuickMealDialog
            dialog={quickMealDialog}
            dateOptions={quickMealDateOptions}
            recipes={recipes}
            isSubmitting={isSubmitting}
            overlayRootClassName="home-dashboard-overlay-root"
            onChange={updateQuickMealDialog}
            onClose={() => setQuickMealDialog(null)}
            onSubmit={submitQuickMealDialog}
          />
        );
      })()}

      {detailFood && (() => {
        const usage = getMealUsage(detailFood, mealLogs);
        const expiry = describeExpiry(detailFood);
        const normalizedType = normalizeFoodType(detailFood);
        const status = getFoodStatus(detailFood, usage, expiry, recipes);
        const factRows = getFoodFactRows(detailFood, usage, expiry);
        const history = getFoodMealHistory(detailFood, mealLogs);
        const relation = buildFoodRelationViewModel(detailFood, recipes, ingredients, inventoryItems, mealLogs, foods);
        const linkedRecipeCard = relation.linkedRecipeCard;
        const recipe = linkedRecipeCard?.recipe ?? (detailFood.recipe_id ? recipes.find((item) => item.id === detailFood.recipe_id) ?? null : null);
        const coverAsset = getFoodCoverAsset(detailFood, recipes);
        const cover = coverAsset?.url;
        const detailMealOptions = detailFood.suitable_meal_types.length > 0
          ? MEAL_OPTIONS.filter((meal) => detailFood.suitable_meal_types.includes(meal.value))
          : MEAL_OPTIONS;

        return (
          <FoodDetailDrawer
            food={detailFood}
            audienceText={getFoodAudienceText(detailFood, mealLogs)}
            cover={cover}
            coverAsset={coverAsset}
            detailMealOptions={detailMealOptions}
            expiry={expiry}
            factRows={factRows}
            history={history}
            isOutsideFood={isOutsideFood(detailFood)}
            isQuickAdding={isQuickAdding}
            isReadyLikeFood={isReadyLikeFood(detailFood)}
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
            onClose={() => setDetailFood(null)}
            onEdit={() => {
              onNavigate({ workspace: 'eat', view: 'food', foodId: detailFood.id });
              setDetailFood(null);
            }}
            onEditRecipe={() => {
              if (detailFood.recipe_id) {
                onNavigate({ workspace: 'eat', view: 'recipe', recipeId: detailFood.recipe_id });
              } else {
                onNavigate({ workspace: 'eat', view: 'food', foodId: detailFood.id });
              }
              setDetailFood(null);
            }}
            onOpenLogs={() => {
              onNavigate({ workspace: 'eat', view: 'history' });
              setDetailFood(null);
            }}
            onOpenPlanDialog={(food) => {
              openHomePlanAddDialog(food, foodRecommendations?.target_meal_type ?? 'dinner');
              setDetailFood(null);
            }}
            onStartCook={(recipeId) => {
              onStartRecommendedRecipe({
                foodId: detailFood.id,
                recipeId,
                date: foodRecommendations?.target_date ?? todayKey(),
                mealType: foodRecommendations?.target_meal_type ?? getSuggestedHomeMealType(),
                servings: 1,
              });
              setDetailFood(null);
            }}
            onQuickAdd={(food, mealType) => {
              openQuickMealDialog(food, mealType);
              setDetailFood(null);
            }}
            resolveAssetUrl={(url) => resolveAssetUrl(url) ?? url}
            overlayRootClassName="home-dashboard-overlay-root"
          />
        );
      })()}

      {morePlansPopover && (
        <WorkspaceOverlayFrame
          rootClassName="home-dashboard-overlay-root"
          onClose={() => setMorePlansPopover(null)}
        >
          <WorkspaceModal
            title={`${formatDate(morePlansPopover.date)} · ${MEAL_TYPE_LABELS[morePlansPopover.mealType]}计划`}
            description={`共 ${morePlansPopover.items.length} 项计划`}
            eyebrow="餐食清单"
            className="home-more-plans-modal"
            onClose={() => setMorePlansPopover(null)}
          >
            <div className="home-more-plans-grid">
              {morePlansPopover.items.map((item) => {
                const planFood = foods.find((food) => food.id === item.food_id);
                const planCoverUrl = resolveAssetUrl(planFood ? getFoodCover(planFood, recipes) : undefined);
                const planTitle = item.recipe_title || item.food_name || planFood?.name || '未命名食物';
                return (
                  <button
                    key={item.id}
                    className={item.status === 'cooked' ? 'dashboard-plan-dish is-cooked' : 'dashboard-plan-dish'}
                    type="button"
                    onClick={() => {
                      openHomePlanDetail(item);
                      setMorePlansPopover(null);
                    }}
                    title={planTitle}
                  >
                    <MediaWithPlaceholder src={planCoverUrl} alt="" />
                    <span>{planTitle}</span>
                  </button>
                );
              })}
            </div>
          </WorkspaceModal>
        </WorkspaceOverlayFrame>
      )}

      <main className="dashboard-page">
        <PageHeader
          title="首页"
          description="把今天要做、要买、要处理的事放在一个清晰工作台里。"
          actions={
            <div className="dashboard-hero-actions">
              <button className="solid-button dashboard-action-primary" type="button" onClick={onOpenGlobalSearch}>
                <DashboardIcon name="search" />
                全局搜索
              </button>
            </div>
          }
        />

        <div className="dashboard-stat-grid">
          {dashboardStats.map((item) => (
            <article key={item.label} className={`dashboard-stat-card card-tone-${item.tone}`}>
              <span className={`dashboard-stat-icon tone-${item.tone}`}>
                <DashboardIcon name={item.icon} />
              </span>
              <div>
                <span>{item.label}</span>
                <strong>
                  {item.value}
                  <small>{item.unit}</small>
                </strong>
                <p>{item.detail}</p>
              </div>
            </article>
          ))}
        </div>

        <section className="home-question-one card dashboard-panel">
          <header className="home-question-head home-question-one-head">
            <div>
              <span>问题 1</span>
              <h2>今天吃什么</h2>
            </div>
            <button
              className="ghost-button button-compact"
              type="button"
              onClick={onNextDesktopRecommendations}
              disabled={recommendationCount <= 3}
            >
              换一批
            </button>
          </header>

          {desktopRecommendations.length > 0 ? (
            <div className="dashboard-food-row">
              {desktopRecommendations.map(({ recommendation, coverUrl }) => {
                const food = recommendation.food;
                const primaryActionLabel = food.recipe_id ? '开始做' : getPrimaryFoodActionLabel(food);
                return (
                  <article
                    key={food.id}
                    className="dashboard-food-card"
                    data-testid="home-recommendation-card"
                    role="button"
                    tabIndex={0}
                    aria-label={`查看食物详情：${food.name}`}
                    onClick={() => openDetail(food)}
                    onKeyDown={(event) => handleRecommendationCardKeyDown(event, food)}
                  >
                    <div className="dashboard-food-cover">
                      <MediaWithPlaceholder src={resolveAssetUrl(coverUrl)} alt="" />
                    </div>
                    <div className="dashboard-food-body">
                      <h3>{food.name}</h3>
                      <div className="dashboard-badge-row">
                        <Badge>{FOOD_TYPE_LABELS[food.type]}</Badge>
                        <Badge>{food.routine_note || `${food.suitable_meal_types.length || 1} 餐适合`}</Badge>
                      </div>
                      <p>{recommendation.reasons[0] ?? food.notes ?? '适合今天安排'}</p>
                      <div className="dashboard-food-actions">
                        <button
                          className="solid-button button-compact"
                          type="button"
                          onClick={(event) => {
                            event.stopPropagation();
                            openQuickMealDialog(food, foodRecommendations?.target_meal_type);
                          }}
                          disabled={isQuickAdding || isCreatingFoodPlanItem}
                        >
                          {primaryActionLabel}
                        </button>
                        <button
                          className="dashboard-icon-button"
                          type="button"
                          onClick={(event) => {
                            event.stopPropagation();
                            openHomePlanAddDialog(food, foodRecommendations?.target_meal_type ?? 'dinner');
                          }}
                          disabled={isCreatingFoodPlanItem}
                          aria-label={`加入菜单：${food.name}`}
                          title="加入菜单"
                        >
                          <DashboardIcon name="calendar" />
                        </button>
                      </div>
                    </div>
                  </article>
                );
              })}
            </div>
          ) : (
            <EmptyState title="暂无推荐" description="补充食材或菜谱后，这里会出现今日建议。" />
          )}

          <HomeCompactCalendar
            days={compactPlanDays}
            selectedDate={selectedPlanDate}
            selectedSummary={selectedPlanSummary}
            onSelectDate={onSelectedPlanDateChange}
            onPreviousWeek={onFoodPlanPreviousWeek}
            onCurrentWeek={onFoodPlanCurrentWeek}
            onNextWeek={onFoodPlanNextWeek}
            onOpenFullWeek={onOpenFullWeek}
          />
        </section>

        <div className="home-dashboard-lower-grid" data-testid="home-lower-grid">
          <HomeRequiredActions
            actions={requiredActions}
            hasMore={hasMoreHomeActions}
            onOpenInventory={handleOpenInventoryAction}
            onOpenShoppingIntake={onOpenShoppingIntake}
            onOpenReconciliation={() => onOpenReconciliation?.({ scope: 'suggested' })}
            onViewAll={onOpenIngredientPriority}
          />
          <HomeHighlightTimeline
            viewModel={homeHighlights}
            limit={5}
            onRetry={onRetryHighlights}
            onViewAll={onOpenFamilyActivity}
          />
        </div>
      </main>
    </>
  );
}
