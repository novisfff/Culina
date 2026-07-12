import type { KeyboardEvent, ReactNode } from 'react';
import type { Food, FoodRecommendations, MealType } from '../../api/types';
import type { TabKey } from '../../app/AppShell';
import { DashboardIcon, ShellIcon } from '../../app/shellIcons';
import { MediaWithPlaceholder } from '../../components/MediaPlaceholder';
import { Badge, EmptyState } from '../../components/ui-kit';
import { FOOD_TYPE_LABELS } from '../../lib/ui';
import type { InventoryActionGroup } from '../inventory/inventoryActionModel';
import {
  type DashboardPlanDay,
  type DashboardRecommendation,
  type DashboardStat,
  type HomeHighlightsViewModel,
  type HomeRequiredAction,
} from './homeDashboardModel';
import { HomeCompactCalendar } from './HomeCompactCalendar';
import { HomeHighlightTimeline } from './HomeHighlightTimeline';
import { HomeRequiredActions } from './HomeRequiredActions';

function MobileQuestionHeading(props: { title: string }) {
  return (
    <div className="mobile-dashboard-section-head">
      <h2>
        {props.title} <span>✦</span>
      </h2>
    </div>
  );
}

function HomeRecommendationCards(props: {
  items: DashboardRecommendation[];
  resolveAssetUrl: (url?: string) => string | undefined;
  targetMealType?: MealType;
  isQuickAdding: boolean;
  isCreatingFoodPlanItem: boolean;
  onOpenDetail: (food: Food) => void;
  onQuickStartFood: (food: Food, fallbackMealType?: MealType) => void;
  onHomePlanAddDialogOpen: (food: Food, fallbackMealType?: MealType) => void;
}) {
  function handleRecommendationCardKeyDown(event: KeyboardEvent<HTMLElement>, food: Food) {
    if (event.key !== 'Enter' && event.key !== ' ') {
      return;
    }
    event.preventDefault();
    props.onOpenDetail(food);
  }

  if (props.items.length === 0) {
    return <EmptyState title="暂无推荐" description="补充食材或菜谱后，这里会出现今日建议。" />;
  }

  return (
    <div className="mobile-dashboard-recommendation-list">
      {props.items.map(({ recommendation, coverUrl }) => {
        const food = recommendation.food;
        const foodCoverUrl = props.resolveAssetUrl(coverUrl);
        return (
          <article
            key={food.id}
            className="mobile-dashboard-food-card"
            data-testid="home-recommendation-card"
            role="button"
            tabIndex={0}
            aria-label={`查看食物详情：${food.name}`}
            onClick={() => props.onOpenDetail(food)}
            onKeyDown={(event) => handleRecommendationCardKeyDown(event, food)}
          >
            <div className="mobile-dashboard-food-cover">
              <MediaWithPlaceholder src={foodCoverUrl} alt="" />
            </div>
            <div className="mobile-dashboard-food-body">
              <h3>{food.name}</h3>
              <div className="mobile-dashboard-badge-row">
                <Badge>{FOOD_TYPE_LABELS[food.type]}</Badge>
                <Badge>{food.routine_note || `${food.suitable_meal_types.length || 1} 餐适合`}</Badge>
              </div>
              <p>{recommendation.reasons[0] ?? food.notes ?? '适合今天安排'}</p>
              <div className="mobile-dashboard-food-actions">
                <button
                  className="mobile-dashboard-primary compact"
                  type="button"
                  onClick={(event) => {
                    event.stopPropagation();
                    props.onQuickStartFood(food, props.targetMealType);
                  }}
                  disabled={props.isQuickAdding || props.isCreatingFoodPlanItem}
                >
                  开始做
                </button>
                <button
                  type="button"
                  onClick={(event) => {
                    event.stopPropagation();
                    props.onHomePlanAddDialogOpen(food, props.targetMealType ?? 'dinner');
                  }}
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
  );
}

export type HomeMobileDashboardProps = {
  sidebarFamilyName: string;
  sidebarMotto: string;
  sidebarLocation: string;
  sidebarMemberLabel: string;
  sidebarActivityLabel: string;
  inventoryAlerts: unknown[];
  notificationCenter?: ReactNode;
  dashboardStats: DashboardStat[];
  mobileRecommendations: DashboardRecommendation[];
  recommendationCount: number;
  foodRecommendations?: FoodRecommendations | null;
  requiredActions: HomeRequiredAction[];
  hasMoreHomeActions: boolean;
  compactPlanDays: DashboardPlanDay[];
  selectedDashboardPlanDay?: DashboardPlanDay;
  selectedPlanSummary: string;
  homeHighlights: HomeHighlightsViewModel;
  isQuickAdding: boolean;
  isCreatingFoodPlanItem: boolean;
  resolveAssetUrl: (url?: string) => string | undefined;
  onNavigate: (tab: TabKey) => void;
  onOpenGlobalSearch: () => void;
  onNextMobileRecommendation: () => void;
  onSelectedPlanDateChange: (date: string) => void;
  onFoodPlanPreviousWeek: () => void;
  onFoodPlanCurrentWeek: () => void;
  onFoodPlanNextWeek: () => void;
  onQuickStartFood: (food: Food, fallbackMealType?: MealType) => void;
  onHomePlanAddDialogOpen: (food: Food, fallbackMealType?: MealType) => void;
  onOpenActionGroup: (group: InventoryActionGroup) => void;
  onOpenIngredientShopping: (ingredientId: string) => void;
  onOpenIngredientPriority: () => void;
  onOpenShoppingIntake: () => void;
  onOpenFamilyActivity: () => void;
  onOpenFullWeek: (planDate: string) => void;
  onRetryHighlights: () => void;
  onOpenDetail: (food: Food) => void;
  onOpenReconciliation?: (args?: {
    scope?: 'suggested' | 'refrigerated' | 'frozen' | 'room_temperature' | 'all';
  }) => void;
};

export function HomeMobileDashboard(props: HomeMobileDashboardProps) {
  const selectedPlanDate = props.selectedDashboardPlanDay?.date ?? props.compactPlanDays[0]?.date ?? '';

  function handleOpenInventoryAction(group: InventoryActionGroup) {
    if (group.kind === 'low_stock') {
      props.onOpenIngredientShopping(group.ingredientId);
      return;
    }
    props.onOpenActionGroup(group);
  }

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
          <article key={item.label} className="mobile-dashboard-stat-card" data-testid="mobile-home-stat">
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

      <section className="mobile-dashboard-panel mobile-home-question" data-testid="mobile-home-question" data-question="1">
        <div className="mobile-home-question-head">
          <MobileQuestionHeading title="今天吃什么" />
          <button
            type="button"
            onClick={props.onNextMobileRecommendation}
            disabled={props.recommendationCount <= 1}
          >
            换一个
          </button>
        </div>
        <HomeRecommendationCards
          items={props.mobileRecommendations}
          resolveAssetUrl={props.resolveAssetUrl}
          targetMealType={props.foodRecommendations?.target_meal_type}
          isQuickAdding={props.isQuickAdding}
          isCreatingFoodPlanItem={props.isCreatingFoodPlanItem}
          onOpenDetail={props.onOpenDetail}
          onQuickStartFood={props.onQuickStartFood}
          onHomePlanAddDialogOpen={props.onHomePlanAddDialogOpen}
        />
        <HomeCompactCalendar
          days={props.compactPlanDays}
          selectedDate={selectedPlanDate}
          selectedSummary={props.selectedPlanSummary}
          onSelectDate={props.onSelectedPlanDateChange}
          onPreviousWeek={props.onFoodPlanPreviousWeek}
          onCurrentWeek={props.onFoodPlanCurrentWeek}
          onNextWeek={props.onFoodPlanNextWeek}
          onOpenFullWeek={props.onOpenFullWeek}
          mobile
        />
      </section>

      <div className="mobile-home-question" data-testid="mobile-home-question" data-question="2">
        <HomeRequiredActions
          actions={props.requiredActions}
          hasMore={props.hasMoreHomeActions}
          onOpenInventory={handleOpenInventoryAction}
          onOpenShoppingIntake={props.onOpenShoppingIntake}
          onOpenReconciliation={() => props.onOpenReconciliation?.({ scope: 'suggested' })}
          onViewAll={props.onOpenIngredientPriority}
        />
      </div>

      <div className="mobile-home-question" data-testid="mobile-home-question" data-question="3">
        <HomeHighlightTimeline
          viewModel={props.homeHighlights}
          limit={3}
          onRetry={props.onRetryHighlights}
          onViewAll={props.onOpenFamilyActivity}
        />
      </div>
    </main>
  );
}
