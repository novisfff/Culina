import { useMemo, useState, type Dispatch, type FormEvent, type KeyboardEvent, type ReactNode, type SetStateAction } from 'react';
import type { ActivityLog, Food, FoodPlanItem, FoodRecommendations, Ingredient, InventoryItem, MealLog, MealType, Member, Recipe, ShoppingListItem } from '../../api/types';
import type { TabKey } from '../../app/AppShell';
import { DashboardIcon, DashboardMealIcon } from '../../app/shellIcons';
import { MediaWithPlaceholder } from '../../components/MediaPlaceholder';
import {
  Badge,
  EmptyState,
  PageHeader,
  StateBlock,
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
import { FOOD_TYPE_LABELS, formatDate, formatDateTime, getFoodCover, getFoodCoverAsset, MEAL_TYPE_LABELS, todayKey } from '../../lib/ui';
import type {
  InventoryActionGroup,
} from '../inventory/inventoryActionModel';
import {
  DASHBOARD_PLAN_MEAL_TYPES,
  findShoppingIngredient,
  formatDashboardPlanRange,
  type DashboardPlanDay,
  type DashboardPlanSummaryItem,
  type DashboardRecommendation,
  type DashboardStat,
} from './homeDashboardModel';
import { HomeMobileDashboard } from './HomeMobileDashboard';
import { FamilyActivityModal } from '../family/FamilyActivityViewer';

function getHomeActionPrimaryLabel(group: InventoryActionGroup) {
  if (group.kind === 'low_stock') {
    return '加入采购';
  }
  if (group.severity === 'expired') {
    return '集中处理';
  }
  return '查看处理';
}

function getHomeActionTone(group: InventoryActionGroup) {
  if (group.kind === 'low_stock') {
    return 'low-stock';
  }
  if (group.severity === 'expired') {
    return 'expired';
  }
  if (group.severity === 'expires_today' || group.severity === 'expires_soon') {
    return 'soon';
  }
  return 'later';
}

function getHomeActionEmptyCopy(hasLaterInventoryActionGroups: boolean) {
  if (hasLaterInventoryActionGroups) {
    return {
      title: '今天没有急着处理的食材',
      description: '4～7 天内的提醒仍可以在食材页查看。',
    };
  }
  return {
    title: '当前库存状态平稳',
    description: '没有过期、临期或待补货的食材需要处理。',
  };
}

export type HomeDashboardProps = {
  sidebarFamilyName: string;
  sidebarMotto: string;
  sidebarLocation: string;
  sidebarMemberLabel: string;
  sidebarActivityLabel: string;
  inventoryAlerts: unknown[];
  notificationCenter?: ReactNode;
  dashboardStats: DashboardStat[];
  dashboardRecommendationItems: DashboardRecommendation[];
  dashboardRecommendationPageCount: number;
  dashboardRecommendations: DashboardRecommendation[];
  foodRecommendations?: FoodRecommendations | null;
  homeInventoryActionGroups: InventoryActionGroup[];
  hasLaterInventoryActionGroups: boolean;
  hasFullListInventoryActionGroups: boolean;
  activeFoodPlanItems: FoodPlanItem[];
  foodPlanItems: FoodPlanItem[];
  dashboardWeekMealCapacity: number;
  dashboardPlanDays: DashboardPlanDay[];
  selectedDashboardPlanDay?: DashboardPlanDay;
  selectedDashboardPlanDateLabel: string;
  pendingShoppingCount: number;
  pendingShoppingPreview: ShoppingListItem[];
  dashboardPlanSummary: DashboardPlanSummaryItem[];
  foodPlanWeekRange: { start: string; end: string };
  foods: Food[];
  recipes: Recipe[];
  ingredients: Ingredient[];
  members: Member[];
  mealLogs: MealLog[];
  inventoryItems: InventoryItem[];
  activityLogs: ActivityLog[];
  recentMeals: MealLog[];
  isQuickAdding: boolean;
  isCreatingFoodPlanItem: boolean;
  resolveAssetUrl: (url?: string) => string | undefined;
  quickAddMeal: (payload: { food_id: string; date: string; meal_type: MealType; servings: number; note: string }) => Promise<unknown>;
  createFoodPlanItem: (payload: { food_id: string; plan_date: string; meal_type: MealType; note: string }) => Promise<FoodPlanItem>;
  onNavigate: (tab: TabKey) => void;
  onOpenGlobalSearch: () => void;
  onRecommendationPageChange: Dispatch<SetStateAction<number>>;
  onStartRecipe: (recipeId: string, foodPlanItemId?: string) => void;
  onSelectedPlanDateChange: (date: string) => void;
  onHomePlanAddDialogOpen: (food: Food, fallbackMealType?: MealType) => void;
  onHomePlanAddEmptyDialogOpen: (planDate: string, mealType: MealType) => void;
  onHomePlanDetailOpen: (item: FoodPlanItem) => void;
  onHomeRestockOpen: (item: ShoppingListItem) => void;
  onOpenActionGroup: (group: InventoryActionGroup) => void;
  onOpenIngredientShopping: (ingredientId: string) => void;
  onOpenIngredientPriority: () => void;
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
    dashboardRecommendationItems,
    dashboardRecommendationPageCount,
    dashboardRecommendations,
    foodRecommendations,
    homeInventoryActionGroups,
    hasLaterInventoryActionGroups,
    hasFullListInventoryActionGroups,
    activeFoodPlanItems,
    foodPlanItems,
    dashboardWeekMealCapacity,
    dashboardPlanDays,
    selectedDashboardPlanDay,
    selectedDashboardPlanDateLabel,
    pendingShoppingCount,
    pendingShoppingPreview,
    dashboardPlanSummary,
    foodPlanWeekRange,
    foods,
    recipes,
    ingredients,
    members,
    mealLogs,
    inventoryItems,
    activityLogs,
    recentMeals,
    isQuickAdding,
    isCreatingFoodPlanItem,
    resolveAssetUrl,
    quickAddMeal,
    createFoodPlanItem,
    onNavigate,
    onOpenGlobalSearch,
    onRecommendationPageChange,
    onStartRecipe,
    onSelectedPlanDateChange,
    onHomePlanAddDialogOpen: openHomePlanAddDialog,
    onHomePlanAddEmptyDialogOpen: openHomePlanAddEmptyDialog,
    onHomePlanDetailOpen: openHomePlanDetail,
    onHomeRestockOpen: openHomeRestock,
    onOpenActionGroup,
    onOpenIngredientShopping,
    onOpenIngredientPriority,
    onFoodPlanPreviousWeek,
    onFoodPlanCurrentWeek,
    onFoodPlanNextWeek,
  } = props;
  const visibleActionGroups = homeInventoryActionGroups.slice(0, 3);
  const emptyActionCopy = getHomeActionEmptyCopy(hasLaterInventoryActionGroups);
  void hasFullListInventoryActionGroups;
  const [quickMealDialog, setQuickMealDialog] = useState<FoodQuickMealDialogState | null>(null);
  const [detailFood, setDetailFood] = useState<Food | null>(null);
  const [isActivityViewerOpen, setIsActivityViewerOpen] = useState(false);
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
    []
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
    if (current.food.recipe_id) {
      const planItem = await createFoodPlanItem({
        food_id: current.food.id,
        plan_date: current.date,
        meal_type: current.mealType,
        note: '',
      });
      setQuickMealDialog(null);
      onStartRecipe(current.food.recipe_id, planItem.id);
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
            dashboardRecommendationItems={dashboardRecommendationItems}
            dashboardRecommendationPageCount={dashboardRecommendationPageCount}
            dashboardRecommendations={dashboardRecommendations}
            foodRecommendations={foodRecommendations}
            homeInventoryActionGroups={visibleActionGroups}
            hasLaterInventoryActionGroups={hasLaterInventoryActionGroups}
            hasFullListInventoryActionGroups={hasFullListInventoryActionGroups}
            activeFoodPlanItems={activeFoodPlanItems}
            dashboardWeekMealCapacity={dashboardWeekMealCapacity}
            dashboardPlanDays={dashboardPlanDays}
            selectedDashboardPlanDay={selectedDashboardPlanDay}
            selectedDashboardPlanDateLabel={selectedDashboardPlanDateLabel}
            pendingShoppingCount={pendingShoppingCount}
            pendingShoppingPreview={pendingShoppingPreview}
            foods={foods}
            recipes={recipes}
            ingredients={ingredients}
            isQuickAdding={isQuickAdding}
            isCreatingFoodPlanItem={isCreatingFoodPlanItem}
            resolveAssetUrl={resolveAssetUrl}
            onNavigate={onNavigate}
            onOpenGlobalSearch={onOpenGlobalSearch}
            onRecommendationPageChange={onRecommendationPageChange}
            onSelectedPlanDateChange={onSelectedPlanDateChange}
            onFoodPlanPreviousWeek={onFoodPlanPreviousWeek}
            onFoodPlanNextWeek={onFoodPlanNextWeek}
            onQuickStartFood={openQuickMealDialog}
            onHomePlanAddDialogOpen={openHomePlanAddDialog}
            onHomePlanAddEmptyDialogOpen={openHomePlanAddEmptyDialog}
            onHomePlanDetailOpen={openHomePlanDetail}
            onHomeRestockOpen={openHomeRestock}
            onOpenActionGroup={onOpenActionGroup}
            onOpenIngredientShopping={onOpenIngredientShopping}
            onOpenIngredientPriority={onOpenIngredientPriority}
            onOpenDetail={openDetail}
            onShowMorePlans={(date, mealType, items) => {
              setMorePlansPopover({ date, mealType, items });
            }}
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

          {isActivityViewerOpen && (
            <FamilyActivityModal
              members={members}
              previewLogs={activityLogs}
              onClose={() => setIsActivityViewerOpen(false)}
            />
          )}

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
                onEdit={(food) => {
                  onNavigate('foods');
                  setDetailFood(null);
                }}
                onEditRecipe={(food) => {
                  onNavigate('foods');
                  setDetailFood(null);
                }}
                onOpenLogs={() => {
                  onNavigate('logs');
                  setDetailFood(null);
                }}
                onOpenPlanDialog={(food) => {
                  openHomePlanAddDialog(food, foodRecommendations?.target_meal_type ?? 'dinner');
                  setDetailFood(null);
                }}
                onStartCook={(recipeId) => {
                  onStartRecipe(recipeId);
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

            <div className="dashboard-layout">
              <div className="dashboard-left">
                <section className="card dashboard-panel dashboard-recommend-panel">
                  <div className="dashboard-panel-head">
                    <h2>今天吃什么 <span>✦</span></h2>
                    <button
                      className="ghost-button button-compact"
                      type="button"
                      onClick={() => onRecommendationPageChange((current) => (current + 1) % dashboardRecommendationPageCount)}
                      disabled={dashboardRecommendationItems.length <= 3}
                    >
                      换一批
                    </button>
                  </div>
                  {dashboardRecommendations.length > 0 ? (
                    <div className="dashboard-food-row">
                      {dashboardRecommendations.map(({ recommendation, coverUrl }) => {
                        const food = recommendation.food;
                        const primaryActionLabel = food.recipe_id ? '开始做' : getPrimaryFoodActionLabel(food);
                        return (
                          <article
                            key={food.id}
                            className="dashboard-food-card"
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
                </section>

                <div className="dashboard-lower-grid">
                  <div className="dashboard-lower-left">
                    <section className="card dashboard-panel dashboard-action-panel">
                      <div className="dashboard-panel-head">
                        <h2>今天要处理</h2>
                        <button className="tertiary-button button-compact" type="button" onClick={onOpenIngredientPriority}>
                          查看全部
                        </button>
                      </div>
                      <div className="dashboard-action-list">
                        {visibleActionGroups.length > 0 ? (
                          visibleActionGroups.map((group) => {
                            const tone = getHomeActionTone(group);
                            const primaryLabel = getHomeActionPrimaryLabel(group);
                            return (
                              <article
                                key={group.id}
                                data-testid="home-action-group"
                                className={`dashboard-action-item action-${tone}`}
                              >
                                <div className="dashboard-action-info">
                                  <strong>{group.title}</strong>
                                  <p>{group.detail}</p>
                                </div>
                                <button
                                  className="solid-button button-compact"
                                  type="button"
                                  data-testid="home-action-primary"
                                  onClick={() => {
                                    if (group.kind === 'low_stock') {
                                      onOpenIngredientShopping(group.ingredientId);
                                      return;
                                    }
                                    onOpenActionGroup(group);
                                  }}
                                  aria-label={`${primaryLabel}${group.ingredientName}`}
                                >
                                  {primaryLabel}
                                </button>
                              </article>
                            );
                          })
                        ) : (
                          <StateBlock status="empty" title={emptyActionCopy.title} description={emptyActionCopy.description} />
                        )}
                      </div>
                    </section>

                    <section className="card dashboard-panel dashboard-activity-panel">
                      <div className="dashboard-panel-head">
                        <h2>最近记录</h2>
                        <button className="tertiary-button button-compact" type="button" onClick={() => setIsActivityViewerOpen(true)}>
                          查看全部
                        </button>
                      </div>
                      <div className="dashboard-activity-list">
                        {activityLogs.map((log, index) => {
                          const meal = recentMeals[index];
                          const plannedFood = foods.find((item) => item.id === foodPlanItems[index]?.food_id);
                          const imageUrl = meal?.photos[0]?.url ?? (plannedFood ? getFoodCover(plannedFood, recipes) : undefined);
                          return (
                            <article key={log.id} className="dashboard-activity-item">
                              <span className={`dashboard-activity-mark tone-${index % 4}`}>
                                {imageUrl ? (
                                  <MediaWithPlaceholder src={resolveAssetUrl(imageUrl)} alt="" />
                                ) : (
                                  <DashboardIcon name={index % 2 === 0 ? 'check' : 'calendar'} />
                                )}
                              </span>
                              <div>
                                <strong>{log.summary}</strong>
                                <p>{log.actor_name ?? '家庭成员'}</p>
                              </div>
                              <small>{formatDateTime(log.created_at)}</small>
                            </article>
                          );
                        })}
                        {activityLogs.length === 0 && <EmptyState title="暂无记录" description="开始记录餐食后，这里会展示厨房动态。" />}
                      </div>
                    </section>
                  </div>

                  <div className="dashboard-lower-right">
                    <section className="card dashboard-panel dashboard-week-panel">
                      <div className="dashboard-week-head">
                        <div className="dashboard-week-title">
                          <h2>本周菜单</h2>
                          <span>
                            <strong>{activeFoodPlanItems.length}</strong> / {dashboardWeekMealCapacity} 餐
                          </span>
                        </div>
                        <div className="dashboard-week-controls" aria-label="菜单周切换">
                          <button
                            className="dashboard-week-nav-button"
                            type="button"
                            onClick={onFoodPlanPreviousWeek}
                          >
                            <DashboardIcon name="arrow-left" />
                            上一周
                          </button>
                          <button
                            className="dashboard-week-range-button"
                            type="button"
                            onClick={onFoodPlanCurrentWeek}
                            title="回到本周"
                          >
                            <DashboardIcon name="calendar" />
                            {formatDashboardPlanRange(foodPlanWeekRange)}
                          </button>
                          <button
                            className="dashboard-week-nav-button"
                            type="button"
                            onClick={onFoodPlanNextWeek}
                          >
                            下一周
                            <DashboardIcon name="arrow-right" />
                          </button>
                        </div>
                        <button className="dashboard-week-edit-button" type="button" onClick={() => onNavigate('foods')}>
                          <DashboardIcon name="edit" />
                          编辑计划
                        </button>
                      </div>
                      <div className="dashboard-week-summary">
                        {dashboardPlanSummary.map((item) => (
                          <div key={item.label} className="dashboard-week-summary-item">
                            <span className={`dashboard-week-summary-icon tone-${item.tone}`}>
                              <DashboardIcon name={item.icon} />
                            </span>
                            <div>
                              <span>{item.label}</span>
                              <strong>{item.value}<small>餐</small></strong>
                            </div>
                          </div>
                        ))}
                      </div>
                      <div className="dashboard-week-grid">
                        {dashboardPlanDays.map((day) => (
                          <button
                            key={day.date}
                            className={[
                              'dashboard-day-card',
                              day.plannedMealCount > 0 ? 'filled' : '',
                              day.isToday ? 'today' : '',
                              day.isSelected ? 'selected' : '',
                            ]
                              .filter(Boolean)
                              .join(' ')}
                            type="button"
                            onClick={() => onSelectedPlanDateChange(day.date)}
                            aria-pressed={day.isSelected}
                          >
                            <span className="dashboard-day-weekday">{day.weekday}</span>
                            {day.isSelected && <span className="dashboard-day-selected-mark">{day.weekday}</span>}
                            <strong>{day.plannedMealCount}/{DASHBOARD_PLAN_MEAL_TYPES.length}</strong>
                            <small>{day.dayLabel}</small>
                            <div className="dashboard-day-meal-dots" aria-label="餐次安排状态">
                              {day.mealItems.map((meal) => (
                                <i
                                  key={meal.mealType}
                                  className={meal.items.length > 0 ? `is-filled meal-${meal.mealType}` : `meal-${meal.mealType}`}
                                  title={MEAL_TYPE_LABELS[meal.mealType]}
                                />
                              ))}
                            </div>
                          </button>
                        ))}
                      </div>
                      {selectedDashboardPlanDay && (
                        <div className="dashboard-plan-detail">
                          <div className="dashboard-plan-detail-head">
                            <strong>{selectedDashboardPlanDateLabel}</strong>
                            <span>{selectedDashboardPlanDay.totalCount} 项计划</span>
                          </div>
                          <div className="dashboard-plan-meal-list">
                            {selectedDashboardPlanDay.mealItems.map((meal) => (
                              <div
                                key={meal.mealType}
                                className={meal.items.length > 0 ? 'dashboard-plan-meal-row filled' : 'dashboard-plan-meal-row'}
                                title={meal.items.length > 0 ? `查看${MEAL_TYPE_LABELS[meal.mealType]}计划` : `添加${MEAL_TYPE_LABELS[meal.mealType]}计划`}
                              >
                                <span className={`dashboard-plan-meal-label meal-${meal.mealType}`}>
                                  <span className="dashboard-plan-meal-label-icon" aria-hidden="true">
                                    <DashboardMealIcon mealType={meal.mealType} />
                                  </span>
                                  <strong>{MEAL_TYPE_LABELS[meal.mealType]}</strong>
                                </span>
                                <span className="dashboard-plan-meal-copy">
                                  {meal.items.length > 0 ? (
                                    <span className="dashboard-plan-dish-list">
                                      {meal.items.slice(0, 4).map((item) => (
                                        (() => {
                                          const planFood = foods.find((food) => food.id === item.food_id);
                                          const planCoverUrl = resolveAssetUrl(planFood ? getFoodCover(planFood, recipes) : undefined);
                                          const planTitle = item.recipe_title || item.food_name || planFood?.name || '未命名食物';
                                          return (
                                            <button
                                              key={item.id}
                                              className={item.status === 'cooked' ? 'dashboard-plan-dish is-cooked' : 'dashboard-plan-dish'}
                                              type="button"
                                              onClick={() => openHomePlanDetail(item)}
                                              title={planTitle}
                                            >
                                              <MediaWithPlaceholder src={planCoverUrl} alt="" />
                                              <span>{planTitle}</span>
                                            </button>
                                          );
                                        })()
                                      ))}
                                      {meal.items.length > 4 && (
                                        <button
                                          className="dashboard-plan-dish is-more"
                                          type="button"
                                          onClick={() => setMorePlansPopover({
                                            date: selectedDashboardPlanDay.date,
                                            mealType: meal.mealType,
                                            items: meal.items
                                          })}
                                          title="查看更多计划"
                                        >
                                          +{meal.items.length - 4}
                                        </button>
                                      )}
                                    </span>
                                  ) : (
                                    <>
                                      <strong>未安排</strong>
                                      <small>去食物页添加计划</small>
                                    </>
                                  )}
                                </span>
                                <button
                                  className="dashboard-plan-meal-action"
                                  type="button"
                                  onClick={() => openHomePlanAddEmptyDialog(selectedDashboardPlanDay.date, meal.mealType)}
                                  aria-label={meal.items.length > 0 ? `查看${MEAL_TYPE_LABELS[meal.mealType]}计划` : `添加${MEAL_TYPE_LABELS[meal.mealType]}计划`}
                                >
                                  <DashboardIcon name="plus" />
                                </button>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                    </section>

                    <section className="card dashboard-panel dashboard-shopping-panel">
                      <div className="dashboard-panel-head">
                        <h2>采购提醒 <span>{pendingShoppingCount} 项待采购</span></h2>
                        <button className="tertiary-button button-compact" type="button" onClick={() => onNavigate('ingredients')}>
                          查看清单
                        </button>
                      </div>
                      <div className="dashboard-shopping-row">
                        {pendingShoppingPreview.length > 0 ? (
                          pendingShoppingPreview.map((item) => {
                            const ingredient = findShoppingIngredient(item, ingredients);
                            const imageUrl = resolveAssetUrl(ingredient?.image?.url);
                            return (
                              <button
                                key={item.id}
                                className="dashboard-shopping-pill"
                                type="button"
                                onClick={() => openHomeRestock(item)}
                                title={`登记库存：${item.title}`}
                              >
                                <span className="dashboard-shopping-image">
                                  <MediaWithPlaceholder src={imageUrl} alt="" />
                                </span>
                                <span className="dashboard-shopping-copy">
                                  <strong>{item.title}</strong>
                                  <p>{item.quantity}{item.unit}</p>
                                </span>
                              </button>
                            );
                          })
                        ) : (
                          <p className="subtle">采购清单已清空。</p>
                        )}
                      </div>
                    </section>
                  </div>
                </div>
              </div>
            </div>
          </main>
    </>
  );
}
