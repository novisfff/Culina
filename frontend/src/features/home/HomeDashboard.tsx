import type { Dispatch, SetStateAction, UIEvent } from 'react';
import type { ActivityLog, Food, FoodPlanItem, FoodRecommendations, Ingredient, InventoryItem, MealLog, MealType, Recipe, ShoppingListItem } from '../../api/types';
import type { TabKey } from '../../app/AppShell';
import { DashboardIcon, DashboardMealIcon, ShellIcon } from '../../app/shellIcons';
import { Badge, EmptyState } from '../../components/ui-kit';
import { buildIngredientPlaceholderSvg, FOOD_TYPE_LABELS, formatDate, formatDateTime, getFoodCover, INVENTORY_STATUS_LABELS, MEAL_TYPE_LABELS } from '../../lib/ui';
import {
  DASHBOARD_PLAN_MEAL_TYPES,
  findShoppingIngredient,
  formatDashboardPlanRange,
  getDashboardExpiryBadge,
  type DashboardExpiryTodoInventoryItem,
  type DashboardPlanDay,
  type DashboardPlanSummaryItem,
  type DashboardRecommendation,
  type DashboardStat,
  type DashboardTodoItem,
} from './homeDashboardModel';

export function HomeDashboard(props: {
  sidebarFamilyName: string;
  sidebarMotto: string;
  sidebarLocation: string;
  sidebarMemberLabel: string;
  sidebarActivityLabel: string;
  inventoryAlerts: unknown[];
  dashboardStats: DashboardStat[];
  dashboardRecommendationItems: DashboardRecommendation[];
  dashboardRecommendationPageCount: number;
  dashboardRecommendations: DashboardRecommendation[];
  foodRecommendations?: FoodRecommendations | null;
  today: string;
  dashboardCompletedCount: number;
  dashboardTodoItems: DashboardTodoItem[];
  visibleDashboardTodoItems: DashboardTodoItem[];
  hasMoreDashboardTodoItems: boolean;
  activeFoodPlanItems: FoodPlanItem[];
  foodPlanItems: FoodPlanItem[];
  dashboardWeekMealCapacity: number;
  dashboardPlanDays: DashboardPlanDay[];
  selectedDashboardPlanDay?: DashboardPlanDay;
  selectedDashboardPlanDateLabel: string;
  pendingShoppingCount: number;
  pendingShoppingPreview: ShoppingListItem[];
  visibleExpiringInventoryItems: DashboardExpiryTodoInventoryItem[];
  hasMoreExpiringInventoryItems: boolean;
  dashboardPlanSummary: DashboardPlanSummaryItem[];
  foodPlanWeekRange: { start: string; end: string };
  foods: Food[];
  recipes: Recipe[];
  ingredients: Ingredient[];
  activityLogs: ActivityLog[];
  recentMeals: MealLog[];
  isQuickAdding: boolean;
  isCreatingFoodPlanItem: boolean;
  resolveAssetUrl: (url?: string) => string | undefined;
  quickAddMeal: (payload: { food_id: string; date: string; meal_type: MealType; servings: number; note: string }) => Promise<unknown>;
  onNavigate: (tab: TabKey) => void;
  onRecommendationPageChange: Dispatch<SetStateAction<number>>;
  onPendingRecipeCookChange: (recipeId: string | null) => void;
  onSelectedPlanDateChange: (date: string) => void;
  onHomePlanAddDialogOpen: (food: Food, fallbackMealType?: MealType) => void;
  onHomePlanAddEmptyDialogOpen: (planDate: string, mealType: MealType) => void;
  onHomePlanDetailOpen: (item: FoodPlanItem) => void;
  onHomeRestockOpen: (item: ShoppingListItem) => void;
  onIngredientsCatalogOpen: () => void;
  onIngredientExpiredDisposalOpen: (ingredientId: string) => void;
  onIngredientDetailOpen: (ingredientId: string) => void;
  onDashboardTodoClick: (item: DashboardTodoItem) => void;
  onExpiryListScroll: (event: UIEvent<HTMLDivElement>) => void;
  onDashboardTodoListScroll: (event: UIEvent<HTMLDivElement>) => void;
  onFoodPlanPreviousWeek: () => void;
  onFoodPlanCurrentWeek: () => void;
  onFoodPlanNextWeek: () => void;
}) {
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
    today,
    dashboardCompletedCount,
    dashboardTodoItems,
    visibleDashboardTodoItems,
    hasMoreDashboardTodoItems,
    activeFoodPlanItems,
    foodPlanItems,
    dashboardWeekMealCapacity,
    dashboardPlanDays,
    selectedDashboardPlanDay,
    selectedDashboardPlanDateLabel,
    pendingShoppingCount,
    pendingShoppingPreview,
    visibleExpiringInventoryItems,
    hasMoreExpiringInventoryItems,
    dashboardPlanSummary,
    foodPlanWeekRange,
    foods,
    recipes,
    ingredients,
    activityLogs,
    recentMeals,
    isQuickAdding,
    isCreatingFoodPlanItem,
    resolveAssetUrl,
    quickAddMeal,
    onNavigate,
    onRecommendationPageChange,
    onPendingRecipeCookChange,
    onSelectedPlanDateChange,
    onHomePlanAddDialogOpen: openHomePlanAddDialog,
    onHomePlanAddEmptyDialogOpen: openHomePlanAddEmptyDialog,
    onHomePlanDetailOpen: openHomePlanDetail,
    onHomeRestockOpen: openHomeRestock,
    onIngredientsCatalogOpen: openIngredientsCatalog,
    onIngredientExpiredDisposalOpen: openIngredientExpiredDisposal,
    onIngredientDetailOpen: openIngredientDetail,
    onDashboardTodoClick: handleDashboardTodoClick,
    onExpiryListScroll: handleExpiryListScroll,
    onDashboardTodoListScroll: handleDashboardTodoListScroll,
    onFoodPlanPreviousWeek,
    onFoodPlanCurrentWeek,
    onFoodPlanNextWeek,
  } = props;

  return (
    <>
          <main className="mobile-dashboard-page" aria-label="手机首页">
            <section className="mobile-dashboard-hero">
              <div className="mobile-dashboard-kitchen" aria-hidden="true">
                <img src="/assets/kitchen_transparent.png" alt="" />
              </div>
              <div className="mobile-dashboard-topbar">
                <div className="mobile-dashboard-brand">
                  <span className="mobile-dashboard-logo">
                    <ShellIcon name="logo" />
                  </span>
                  <span>
                    <strong>Culina</strong>
                    <small>家庭厨房工作台</small>
                  </span>
                </div>
                <div className="mobile-dashboard-icon-actions">
                  <button type="button" onClick={() => onNavigate('foods')} aria-label="搜索食物">
                    <DashboardIcon name="search" />
                  </button>
                  <button type="button" onClick={() => onNavigate('ingredients')} aria-label="查看提醒">
                    <DashboardIcon name="bell" />
                    {inventoryAlerts.length > 0 && <i aria-hidden="true" />}
                  </button>
                </div>
              </div>

              <div className="mobile-dashboard-family">
                <div className="mobile-dashboard-family-copy">
                  <h1>{sidebarFamilyName}</h1>
                  <p>{sidebarMotto || '今天吃得好，明天更有劲儿'} <span aria-hidden="true">☀</span></p>
                  <div className="mobile-dashboard-meta-row" aria-label="家庭信息">
                    <span>
                      <DashboardIcon name="map-pin" />
                      {sidebarLocation}
                    </span>
                    <span>
                      <DashboardIcon name="family" />
                      {sidebarMemberLabel}
                    </span>
                    <span>
                      <DashboardIcon name="check" />
                      {sidebarActivityLabel}
                    </span>
                  </div>
                </div>
              </div>

              <div className="mobile-dashboard-actions">
                <button className="mobile-dashboard-primary" type="button" onClick={() => onNavigate('ingredients')}>
                  <DashboardIcon name="plus" />
                  新增食材
                </button>
                <button className="mobile-dashboard-secondary" type="button" onClick={() => onNavigate('logs')}>
                  <DashboardIcon name="receipt" />
                  记录一餐
                </button>
              </div>
            </section>

            <section className="mobile-dashboard-stat-strip" aria-label="厨房状态">
              {dashboardStats.map((item) => (
                <article key={item.label} className="mobile-dashboard-stat-card">
                  <span className={`mobile-dashboard-stat-icon tone-${item.tone}`}>
                    <DashboardIcon name={item.icon} />
                  </span>
                  <span>{item.label}</span>
                  <strong>
                    {item.value}
                    <small>{item.unit}</small>
                  </strong>
                  <p>{item.detail}</p>
                </article>
              ))}
            </section>

            <section className="mobile-dashboard-panel mobile-dashboard-recommend">
              <div className="mobile-dashboard-section-head">
                <h2>今天吃什么 <span>✦</span></h2>
                <button
                  type="button"
                  onClick={() => onRecommendationPageChange((current) => (current + 1) % dashboardRecommendationPageCount)}
                  disabled={dashboardRecommendationItems.length <= 3}
                >
                  换一换
                </button>
              </div>
              {dashboardRecommendations.length > 0 ? (
                <div className="mobile-dashboard-food-scroller">
                  {dashboardRecommendations.map(({ recommendation, coverUrl }) => {
                    const food = recommendation.food;
                    const foodCoverUrl = resolveAssetUrl(coverUrl);
                    return (
                      <article key={food.id} className="mobile-dashboard-food-card">
                        <div
                          className="mobile-dashboard-food-cover"
                          style={foodCoverUrl ? { backgroundImage: `url("${foodCoverUrl}")` } : undefined}
                        />
                        <div className="mobile-dashboard-food-body">
                          <h3>{food.name}</h3>
                          <div className="mobile-dashboard-chip-row">
                            <Badge>{FOOD_TYPE_LABELS[food.type]}</Badge>
                            <Badge>{food.routine_note || `${food.suitable_meal_types.length || 1} 餐适合`}</Badge>
                          </div>
                          <p>{recommendation.reasons[0] ?? food.notes ?? '适合今天安排'}</p>
                          <div className="mobile-dashboard-food-actions">
                            <button
                              className="mobile-dashboard-primary compact"
                              type="button"
                              onClick={() => {
                                if (food.recipe_id) {
                                  onPendingRecipeCookChange(food.recipe_id);
                                  onNavigate('recipes');
                                  return;
                                }
                                void quickAddMeal({
                                  food_id: food.id,
                                  date: today,
                                  meal_type: foodRecommendations?.target_meal_type ?? 'dinner',
                                  servings: 1,
                                  note: '首页快捷记录',
                                });
                              }}
                              disabled={isQuickAdding}
                            >
                              开始做
                            </button>
                            <button type="button" onClick={() => onNavigate('foods')} aria-label="查看食物">
                              <DashboardIcon name="list" />
                            </button>
                            <button
                              type="button"
                              onClick={() => openHomePlanAddDialog(food, foodRecommendations?.target_meal_type ?? 'dinner')}
                              disabled={isCreatingFoodPlanItem}
                              aria-label={`加入菜单：${food.name}`}
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

            <section className="mobile-dashboard-panel">
              <div className="mobile-dashboard-section-head">
                <h2>今日待办</h2>
                <Badge>{dashboardCompletedCount} / {dashboardTodoItems.length || 0}</Badge>
              </div>
              <div className="mobile-dashboard-todo-list">
                {dashboardTodoItems.length > 0 ? (
                  dashboardTodoItems.slice(0, 4).map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      className={item.done ? 'mobile-dashboard-todo-item done' : `mobile-dashboard-todo-item todo-${item.type}`}
                      onClick={() => handleDashboardTodoClick(item)}
                      aria-label={`${item.title}，${item.status}，点击处理`}
                    >
                      <span className="mobile-dashboard-todo-icon">
                        <DashboardIcon name={item.icon} />
                      </span>
                      <span className="mobile-dashboard-todo-copy">
                        <strong>{item.title}</strong>
                        <small>{item.description}</small>
                      </span>
                      <span className="mobile-dashboard-todo-meta">
                        <Badge className={item.done ? 'dashboard-done-badge' : item.status === '紧急' ? 'dashboard-danger-badge' : 'dashboard-wait-badge'}>
                          {item.status}
                        </Badge>
                        <small>{item.dateLabel}</small>
                      </span>
                      <span className="mobile-dashboard-todo-arrow" aria-hidden="true">
                        <DashboardIcon name="chevron" />
                      </span>
                    </button>
                  ))
                ) : (
                  <EmptyState title="今日没有待办" description="新的临期、采购和餐食记录会自动出现在这里。" />
                )}
              </div>
            </section>

            <section className="mobile-dashboard-panel mobile-dashboard-week">
              <div className="mobile-dashboard-section-head">
                <h2>本周菜单 <span>{activeFoodPlanItems.length} / {dashboardWeekMealCapacity} 餐</span></h2>
                <button type="button" onClick={() => onNavigate('foods')}>
                  <DashboardIcon name="edit" />
                  编辑计划
                </button>
              </div>
              <div className="mobile-dashboard-week-row">
                {dashboardPlanDays.map((day) => (
                  <button
                    key={day.date}
                    className={[
                      'mobile-dashboard-day-card',
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
                    <span>{day.weekday}</span>
                    <strong>{day.plannedMealCount}/{DASHBOARD_PLAN_MEAL_TYPES.length}</strong>
                    <small>{day.dayLabel}</small>
                    <i aria-hidden="true">
                      {day.mealItems.map((meal) => (
                        <b
                          key={meal.mealType}
                          className={meal.items.length > 0 ? `is-filled meal-${meal.mealType}` : `meal-${meal.mealType}`}
                        />
                      ))}
                    </i>
                  </button>
                ))}
              </div>
              {selectedDashboardPlanDay && (
                <div className="mobile-dashboard-plan-detail">
                  <div className="mobile-dashboard-plan-detail-head">
                    <strong>{selectedDashboardPlanDateLabel}</strong>
                    <span>{selectedDashboardPlanDay.totalCount} 项计划</span>
                  </div>
                  <div className="mobile-dashboard-plan-meals">
                    {selectedDashboardPlanDay.mealItems.map((meal) => (
                      <div
                        key={meal.mealType}
                        className={meal.items.length > 0 ? 'mobile-dashboard-plan-meal filled' : 'mobile-dashboard-plan-meal'}
                      >
                        <span className={`mobile-dashboard-plan-meal-label meal-${meal.mealType}`}>
                          <DashboardMealIcon mealType={meal.mealType} />
                          <strong>{MEAL_TYPE_LABELS[meal.mealType]}</strong>
                        </span>
                        <div className="mobile-dashboard-plan-meal-dishes">
                          {meal.items.length > 0 ? (
                            meal.items.slice(0, 3).map((item) => {
                              const planFood = foods.find((food) => food.id === item.food_id);
                              const planCoverUrl = resolveAssetUrl(planFood ? getFoodCover(planFood, recipes) : undefined);
                              const planTitle = item.recipe_title || item.food_name || planFood?.name || '未命名食物';
                              return (
                                <button
                                  key={item.id}
                                  type="button"
                                  className={item.status === 'cooked' ? 'mobile-dashboard-plan-dish cooked' : 'mobile-dashboard-plan-dish'}
                                  onClick={() => openHomePlanDetail(item)}
                                  title={planTitle}
                                >
                                  {planCoverUrl && <img src={planCoverUrl} alt="" />}
                                  <span>{planTitle}</span>
                                </button>
                              );
                            })
                          ) : (
                            <span className="mobile-dashboard-plan-empty">未安排</span>
                          )}
                          {meal.items.length > 3 && (
                            <span className="mobile-dashboard-plan-more">+{meal.items.length - 3}</span>
                          )}
                        </div>
                        <button
                          className="mobile-dashboard-plan-add"
                          type="button"
                          onClick={() => openHomePlanAddEmptyDialog(selectedDashboardPlanDay.date, meal.mealType)}
                          aria-label={`添加${MEAL_TYPE_LABELS[meal.mealType]}计划`}
                        >
                          <DashboardIcon name="plus" />
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </section>

            <section className="mobile-dashboard-panel">
              <div className="mobile-dashboard-section-head">
                <h2>采购提醒 <span>{pendingShoppingCount} 项待采购</span></h2>
                <button type="button" onClick={() => onNavigate('ingredients')}>查看清单</button>
              </div>
              <div className="mobile-dashboard-shopping-row">
                {pendingShoppingPreview.length > 0 ? (
                  pendingShoppingPreview.map((item) => {
                    const ingredient = findShoppingIngredient(item, ingredients);
                    const imageUrl = ingredient?.image?.url ? resolveAssetUrl(ingredient.image.url) : buildIngredientPlaceholderSvg(item.title);
                    return (
                      <button
                        key={item.id}
                        className="mobile-dashboard-shopping-pill"
                        type="button"
                        onClick={() => openHomeRestock(item)}
                        title={`登记库存：${item.title}`}
                      >
                        <span>
                          <img src={imageUrl} alt="" />
                        </span>
                        <strong>{item.title}</strong>
                        <small>{item.quantity}{item.unit}</small>
                      </button>
                    );
                  })
                ) : (
                  <p className="subtle">采购清单已清空。</p>
                )}
              </div>
            </section>
          </main>

          <main className="dashboard-page">
            <section className="card dashboard-hero">
              <div className="dashboard-hero-head">
                <div>
                  <h1>首页</h1>
                  <p>把今天要做、要买、要处理的事放在一个清晰工作台里。</p>
                </div>
                <div className="dashboard-hero-actions">
                  <button className="solid-button dashboard-action-primary" type="button" onClick={() => onNavigate('ingredients')}>
                    <DashboardIcon name="plus" />
                    新增食材
                  </button>
                  <button className="ghost-button dashboard-action-secondary" type="button" onClick={() => onNavigate('logs')}>
                    <DashboardIcon name="receipt" />
                    记录一餐
                  </button>
                </div>
              </div>

              <div className="dashboard-stat-grid">
                {dashboardStats.map((item) => (
                  <article key={item.label} className="dashboard-stat-card">
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
            </section>

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
                        return (
                          <article key={food.id} className="dashboard-food-card">
                            <div
                              className="dashboard-food-cover"
                              style={
                                resolveAssetUrl(coverUrl)
                                  ? { backgroundImage: `url("${resolveAssetUrl(coverUrl)}")` }
                                  : undefined
                              }
                            />
                            <div className="dashboard-food-body">
                              <h3>{food.name}</h3>
                              <div className="dashboard-chip-row">
                                <Badge>{FOOD_TYPE_LABELS[food.type]}</Badge>
                                <Badge>{food.routine_note || `${food.suitable_meal_types.length || 1} 餐适合`}</Badge>
                              </div>
                              <p>{recommendation.reasons[0] ?? food.notes ?? '适合今天安排'}</p>
                              <div className="dashboard-food-actions">
                                <button
                                  className="solid-button button-compact"
                                  type="button"
                                  onClick={() => {
                                    if (food.recipe_id) {
                                      onPendingRecipeCookChange(food.recipe_id);
                                      onNavigate('recipes');
                                      return;
                                    }
                                    void quickAddMeal({
                                      food_id: food.id,
                                      date: today,
                                      meal_type: foodRecommendations?.target_meal_type ?? 'dinner',
                                      servings: 1,
                                      note: '首页快捷记录',
                                    });
                                  }}
                                  disabled={isQuickAdding}
                                >
                                  开始做
                                </button>
                                <button className="dashboard-icon-button" type="button" onClick={() => onNavigate('foods')} aria-label="查看食物">
                                  <DashboardIcon name="list" />
                                </button>
                                <button
                                  className="dashboard-icon-button"
                                  type="button"
                                  onClick={() => openHomePlanAddDialog(food, foodRecommendations?.target_meal_type ?? 'dinner')}
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
                    <section className="card dashboard-panel dashboard-expiry-panel">
                      <div className="dashboard-panel-head">
                        <h2>临期优先处理</h2>
                        <button className="tertiary-button button-compact" type="button" onClick={openIngredientsCatalog}>
                          查看全部
                        </button>
                      </div>
                      <div className="dashboard-expiry-list" onScroll={handleExpiryListScroll}>
                        {visibleExpiringInventoryItems.length > 0 ? (
                          visibleExpiringInventoryItems.map((item) => {
                            const ingredient = ingredients.find((entry) => entry.id === item.ingredient_id);
                            const expiryBadge = getDashboardExpiryBadge(item.daysLeft);
                            return (
                              <article key={item.id} className="dashboard-expiry-item">
                                <div className="dashboard-ingredient-thumb">
                                  {ingredient?.image ? (
                                    <img
                                      src={resolveAssetUrl(ingredient.image.url)}
                                      alt={item.ingredient_name}
                                    />
                                  ) : (
                                    <span>{item.ingredient_name.slice(0, 1)}</span>
                                  )}
                                </div>
                                <div>
                                  <strong>{item.ingredient_name}</strong>
                                  <p>{item.storage_location || INVENTORY_STATUS_LABELS[item.status]}</p>
                                </div>
                                <Badge className={expiryBadge.className}>
                                  {expiryBadge.label}
                                </Badge>
                                <button
                                  className="solid-button button-compact"
                                  type="button"
                                  onClick={() =>
                                    item.daysLeft < 0
                                      ? openIngredientExpiredDisposal(item.ingredient_id)
                                      : openIngredientDetail(item.ingredient_id)
                                  }
                                >
                                  去处理
                                </button>
                              </article>
                            );
                          })
                        ) : (
                          <EmptyState title="没有临期食材" description="库存状态很稳，可以放心安排菜单。" />
                        )}
                        {hasMoreExpiringInventoryItems && (
                          <div className="dashboard-expiry-loading">继续下滑加载更多</div>
                        )}
                      </div>
                    </section>

                    <section className="card dashboard-panel dashboard-todo-panel">
                      <div className="dashboard-panel-head">
                        <h2>今日待办</h2>
                        <Badge>{dashboardCompletedCount} / {dashboardTodoItems.length || 0}</Badge>
                      </div>
                      <div className="dashboard-todo-list" onScroll={handleDashboardTodoListScroll}>
                        {dashboardTodoItems.length > 0 ? (
                          <>
                            {visibleDashboardTodoItems.map((item) => (
                              <button
                                key={item.id}
                                type="button"
                                className={item.done ? 'dashboard-todo-item done' : `dashboard-todo-item todo-${item.type}`}
                                onClick={() => handleDashboardTodoClick(item)}
                                aria-label={`${item.title}，${item.status}，点击处理`}
                              >
                                <span className="dashboard-todo-check">
                                  <DashboardIcon name={item.icon} />
                                </span>
                                <span className="dashboard-todo-copy">
                                  <strong>{item.title}</strong>
                                  <span>{item.description}</span>
                                </span>
                                <span className="dashboard-todo-meta">
                                  <Badge className={item.done ? 'dashboard-done-badge' : item.status === '紧急' ? 'dashboard-danger-badge' : 'dashboard-wait-badge'}>
                                    {item.status}
                                  </Badge>
                                  <small>{item.dateLabel}</small>
                                </span>
                                <span className="dashboard-todo-arrow" aria-hidden="true">
                                  <DashboardIcon name="chevron" />
                                </span>
                              </button>
                            ))}
                            {hasMoreDashboardTodoItems && (
                              <div className="dashboard-todo-loading">继续下滑加载更多</div>
                            )}
                          </>
                        ) : (
                          <EmptyState title="今日没有待办" description="新的临期、采购和餐食记录会自动出现在这里。" />
                        )}
                      </div>
                    </section>

                    <section className="card dashboard-panel dashboard-activity-panel">
                      <div className="dashboard-panel-head">
                        <h2>最近记录</h2>
                        <button className="tertiary-button button-compact" type="button" onClick={() => onNavigate('logs')}>
                          查看全部
                        </button>
                      </div>
                      <div className="dashboard-activity-list">
                        {activityLogs.slice(0, 4).map((log, index) => {
                          const meal = recentMeals[index];
                          const plannedFood = foods.find((item) => item.id === foodPlanItems[index]?.food_id);
                          const imageUrl = meal?.photos[0]?.url ?? (plannedFood ? getFoodCover(plannedFood, recipes) : undefined);
                          return (
                            <article key={log.id} className="dashboard-activity-item">
                              <span className={`dashboard-activity-mark tone-${index % 4}`}>
                                {imageUrl ? (
                                  <img src={resolveAssetUrl(imageUrl)} alt="" />
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
                                              {planCoverUrl && <img src={planCoverUrl} alt="" />}
                                              <span>{planTitle}</span>
                                            </button>
                                          );
                                        })()
                                      ))}
                                      {meal.items.length > 4 && <span className="dashboard-plan-dish is-more">+{meal.items.length - 4}</span>}
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
                            const imageUrl = ingredient?.image?.url ? resolveAssetUrl(ingredient.image.url) : buildIngredientPlaceholderSvg(item.title);
                            return (
                              <button
                                key={item.id}
                                className="dashboard-shopping-pill"
                                type="button"
                                onClick={() => openHomeRestock(item)}
                                title={`登记库存：${item.title}`}
                              >
                                <span className="dashboard-shopping-image">
                                  <img src={imageUrl} alt="" />
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
