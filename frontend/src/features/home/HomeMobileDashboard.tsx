import type { Dispatch, SetStateAction } from 'react';
import type { ReactNode } from 'react';
import type { Food, FoodPlanItem, FoodRecommendations, Ingredient, MealType, Recipe, ShoppingListItem } from '../../api/types';
import type { TabKey } from '../../app/AppShell';
import { DashboardIcon, DashboardMealIcon, ShellIcon } from '../../app/shellIcons';
import { MediaWithPlaceholder } from '../../components/MediaPlaceholder';
import { Badge, EmptyState } from '../../components/ui-kit';
import { FOOD_TYPE_LABELS, getFoodCover, MEAL_TYPE_LABELS } from '../../lib/ui';
import {
  DASHBOARD_PLAN_MEAL_TYPES,
  findShoppingIngredient,
  type DashboardPlanDay,
  type DashboardRecommendation,
  type DashboardStat,
  type DashboardTodoItem,
} from './homeDashboardModel';

export function HomeMobileDashboard(props: {
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
  dashboardCompletedCount: number;
  dashboardTodoItems: DashboardTodoItem[];
  activeFoodPlanItems: FoodPlanItem[];
  dashboardWeekMealCapacity: number;
  dashboardPlanDays: DashboardPlanDay[];
  selectedDashboardPlanDay?: DashboardPlanDay;
  selectedDashboardPlanDateLabel: string;
  pendingShoppingCount: number;
  pendingShoppingPreview: ShoppingListItem[];
  foods: Food[];
  recipes: Recipe[];
  ingredients: Ingredient[];
  isQuickAdding: boolean;
  isCreatingFoodPlanItem: boolean;
  resolveAssetUrl: (url?: string) => string | undefined;
  onNavigate: (tab: TabKey) => void;
  onOpenGlobalSearch: () => void;
  onRecommendationPageChange: Dispatch<SetStateAction<number>>;
  onSelectedPlanDateChange: (date: string) => void;
  onFoodPlanPreviousWeek: () => void;
  onFoodPlanNextWeek: () => void;
  onQuickStartFood: (food: Food, fallbackMealType?: MealType) => void;
  onHomePlanAddDialogOpen: (food: Food, fallbackMealType?: MealType) => void;
  onHomePlanAddEmptyDialogOpen: (planDate: string, mealType: MealType) => void;
  onHomePlanDetailOpen: (item: FoodPlanItem) => void;
  onHomeRestockOpen: (item: ShoppingListItem) => void;
  onDashboardTodoClick: (item: DashboardTodoItem) => void;
  onOpenDetail: (food: Food) => void;
  onShowMorePlans?: (date: string, mealType: MealType, items: FoodPlanItem[]) => void;
}) {
  return (
    <main className="mobile-dashboard-page" aria-label="手机首页">
      <section className="mobile-dashboard-hero">
        <div className="mobile-dashboard-kitchen" aria-hidden="true">
          <img
            src="/assets/kitchen_transparent.webp"
            alt=""
          />
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
            <button type="button" onClick={props.onOpenGlobalSearch} aria-label="全局搜索">
              <DashboardIcon name="search" />
            </button>
            {props.notificationCenter ?? (
              <button type="button" onClick={() => props.onNavigate('ingredients')} aria-label="查看提醒">
                <DashboardIcon name="bell" />
                {props.inventoryAlerts.length > 0 && <i aria-hidden="true" />}
              </button>
            )}
          </div>
        </div>

        <div className="mobile-dashboard-family">
          <div className="mobile-dashboard-family-copy">
            <h1>{props.sidebarFamilyName}</h1>
            <p>{props.sidebarMotto || '今天吃得好，明天更有劲儿'} <span aria-hidden="true">☀</span></p>
            <div className="mobile-dashboard-meta-row" aria-label="家庭信息">
              <span>
                <DashboardIcon name="map-pin" />
                {props.sidebarLocation}
              </span>
              <span>
                <DashboardIcon name="family" />
                {props.sidebarMemberLabel}
              </span>
              <span>
                <DashboardIcon name="check" />
                {props.sidebarActivityLabel}
              </span>
            </div>
          </div>
        </div>

        <div className="mobile-dashboard-actions">
          <button className="mobile-dashboard-primary" type="button" onClick={() => props.onNavigate('ingredients')}>
            <DashboardIcon name="plus" />
            新增食材
          </button>
          <button className="mobile-dashboard-secondary" type="button" onClick={() => props.onNavigate('logs')}>
            <DashboardIcon name="receipt" />
            查看记录
          </button>
        </div>
      </section>

      <section className="mobile-dashboard-stat-strip" aria-label="厨房状态">
        {props.dashboardStats.map((item) => (
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
            onClick={() => props.onRecommendationPageChange((current) => (current + 1) % props.dashboardRecommendationPageCount)}
            disabled={props.dashboardRecommendationItems.length <= 3}
          >
            换一换
          </button>
        </div>
        {props.dashboardRecommendations.length > 0 ? (
          <div className="mobile-dashboard-food-scroller">
            {props.dashboardRecommendations.map(({ recommendation, coverUrl }) => {
              const food = recommendation.food;
              const foodCoverUrl = props.resolveAssetUrl(coverUrl);
              return (
                <article key={food.id} className="mobile-dashboard-food-card">
                  <div className="mobile-dashboard-food-cover">
                    <MediaWithPlaceholder src={foodCoverUrl} alt="" />
                  </div>
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
                        onClick={() => props.onQuickStartFood(food, props.foodRecommendations?.target_meal_type)}
                        disabled={props.isQuickAdding || props.isCreatingFoodPlanItem}
                      >
                        开始做
                      </button>
                      <button
                        type="button"
                        onClick={() => props.onOpenDetail(food)}
                        aria-label="查看食物详情"
                        title="查看详情"
                      >
                        <DashboardIcon name="list" />
                      </button>
                      <button
                        type="button"
                        onClick={() => props.onHomePlanAddDialogOpen(food, props.foodRecommendations?.target_meal_type ?? 'dinner')}
                        disabled={props.isCreatingFoodPlanItem}
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
          <Badge>{props.dashboardCompletedCount} / {props.dashboardTodoItems.length || 0}</Badge>
        </div>
        <div className="mobile-dashboard-todo-list">
          {props.dashboardTodoItems.length > 0 ? (
            props.dashboardTodoItems.slice(0, 4).map((item) => (
              <button
                key={item.id}
                type="button"
                className={item.done ? 'mobile-dashboard-todo-item done' : `mobile-dashboard-todo-item todo-${item.type} status-${item.status === '紧急' ? 'emergency' : 'normal'}`}
                onClick={() => props.onDashboardTodoClick(item)}
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
          <h2>本周菜单 <span>{props.activeFoodPlanItems.length} / {props.dashboardWeekMealCapacity} 餐</span></h2>
          <div className="mobile-dashboard-week-switcher" aria-label="切换菜单周">
            <button type="button" onClick={props.onFoodPlanPreviousWeek} aria-label="上一周">
              <DashboardIcon name="arrow-left" />
              上周
            </button>
            <button type="button" onClick={props.onFoodPlanNextWeek} aria-label="下一周">
              下周
              <DashboardIcon name="arrow-right" />
            </button>
          </div>
        </div>
        <div className="mobile-dashboard-week-row">
          {props.dashboardPlanDays.map((day) => (
            <button
              key={day.date}
              className={[
                'mobile-dashboard-day-card',
                day.plannedMealCount > 0 ? 'filled' : '',
                day.isToday ? 'today' : '',
                day.isSelected ? 'selected' : '',
              ].filter(Boolean).join(' ')}
              type="button"
              onClick={() => props.onSelectedPlanDateChange(day.date)}
              aria-pressed={day.isSelected}
            >
              <span>{day.weekday}</span>
              <strong>{day.plannedMealCount}/{DASHBOARD_PLAN_MEAL_TYPES.length}</strong>
              <small>{day.dayLabel}</small>
              <i aria-hidden="true">
                {day.mealItems.map((meal) => (
                  <b key={meal.mealType} className={meal.items.length > 0 ? `is-filled meal-${meal.mealType}` : `meal-${meal.mealType}`} />
                ))}
              </i>
            </button>
          ))}
        </div>
        {props.selectedDashboardPlanDay && (
          <div className="mobile-dashboard-plan-detail">
            <div className="mobile-dashboard-plan-detail-head">
              <strong>{props.selectedDashboardPlanDateLabel}</strong>
              <span>{props.selectedDashboardPlanDay.totalCount} 项计划</span>
            </div>
            <div className="mobile-dashboard-plan-meals">
              {props.selectedDashboardPlanDay.mealItems.map((meal) => (
                <div key={meal.mealType} className={meal.items.length > 0 ? 'mobile-dashboard-plan-meal filled' : 'mobile-dashboard-plan-meal'}>
                  <span className={`mobile-dashboard-plan-meal-label meal-${meal.mealType}`}>
                    <DashboardMealIcon mealType={meal.mealType} />
                    <strong>{MEAL_TYPE_LABELS[meal.mealType]}</strong>
                  </span>
                  <div className="mobile-dashboard-plan-meal-dishes">
                    {meal.items.length > 0 ? (
                      meal.items.slice(0, 3).map((item) => {
                        const planFood = props.foods.find((food) => food.id === item.food_id);
                        const planCoverUrl = props.resolveAssetUrl(planFood ? getFoodCover(planFood, props.recipes) : undefined);
                        const planTitle = item.recipe_title || item.food_name || planFood?.name || '未命名食物';
                        return (
                          <button
                            key={item.id}
                            type="button"
                            className={item.status === 'cooked' ? 'mobile-dashboard-plan-dish cooked' : 'mobile-dashboard-plan-dish'}
                            onClick={() => props.onHomePlanDetailOpen(item)}
                            title={planTitle}
                          >
                            <MediaWithPlaceholder src={planCoverUrl} alt="" />
                            <span>{planTitle}</span>
                          </button>
                        );
                      })
                    ) : (
                      <span className="mobile-dashboard-plan-empty">未安排</span>
                    )}
                    {meal.items.length > 3 && (
                      <button
                        className="mobile-dashboard-plan-more"
                        type="button"
                        onClick={() => props.onShowMorePlans?.(props.selectedDashboardPlanDay!.date, meal.mealType, meal.items)}
                        title="查看更多计划"
                      >
                        +{meal.items.length - 3}
                      </button>
                    )}
                  </div>
                  <button
                    className="mobile-dashboard-plan-add"
                    type="button"
                    onClick={() => props.onHomePlanAddEmptyDialogOpen(props.selectedDashboardPlanDay!.date, meal.mealType)}
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
          <h2>采购提醒 <span>{props.pendingShoppingCount} 项待采购</span></h2>
          <button type="button" onClick={() => props.onNavigate('ingredients')}>查看清单</button>
        </div>
        <div className="mobile-dashboard-shopping-row">
          {props.pendingShoppingPreview.length > 0 ? (
            props.pendingShoppingPreview.map((item) => {
              const ingredient = findShoppingIngredient(item, props.ingredients);
              const imageUrl = props.resolveAssetUrl(ingredient?.image?.url);
              return (
                <button
                  key={item.id}
                  className="mobile-dashboard-shopping-pill"
                  type="button"
                  onClick={() => props.onHomeRestockOpen(item)}
                  title={`登记库存：${item.title}`}
                >
                  <span>
                    <MediaWithPlaceholder src={imageUrl} alt="" />
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
  );
}
