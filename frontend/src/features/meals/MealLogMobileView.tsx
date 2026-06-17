import type { ReactNode } from 'react';
import type { MealLog } from '../../api/types';
import { Badge } from '../../components/ui-kit';
import { FoodUiIcon } from '../../components/foods/FoodWorkspacePrimitives';
import { formatDate, MEAL_TYPE_LABELS } from '../../lib/ui';
import type { MealSource } from './MealLogEnrichment';
import { MealLogIcon } from './MealLogIcons';
import {
  MEAL_FILTERS,
  STATUS_FILTERS,
  buildMealTitle,
  formatDateGroupLabel,
  formatMealTime,
  getMealIconName,
  getMealLogStatusLabel,
  getMealTone,
  type MealLogMealFilter,
  type MealLogStatusFilter,
} from './MealLogWorkspaceModel';

type Props = {
  recentMeals: MealLog[];
  pendingMeals: MealLog[];
  selectedMeal: MealLog | null;
  mealSources: Map<string, MealSource>;
  todayMealCount: number;
  enrichedCount: number;
  weekRecordCount: number;
  groupedMeals: Array<{ date: string; meals: MealLog[] }>;
  searchQuery: string;
  statusFilter: MealLogStatusFilter;
  mealFilter: MealLogMealFilter;
  onSelectMeal: (mealId: string) => void;
  onOpenMealRecord: (meal: MealLog) => void;
  onBackHome: () => void;
  onSearchChange: (value: string) => void;
  onStatusFilterChange: (value: MealLogStatusFilter) => void;
  onMealFilterChange: (value: MealLogMealFilter) => void;
  notificationCenter?: ReactNode;
};

const iconSlotStyle = {
  width: 20,
  height: 20,
  display: 'inline-grid',
  placeItems: 'center',
  lineHeight: 0,
  flex: '0 0 20px',
} as const;

const compactIconSlotStyle = {
  width: 18,
  height: 18,
  display: 'inline-grid',
  placeItems: 'center',
  lineHeight: 0,
  flex: '0 0 18px',
} as const;

export function MealLogMobileView(props: Props) {
  const mobileStats = [
    { label: '今日已记录', value: props.todayMealCount, detail: '来自计划记录', tone: 'orange', icon: 'today' as const },
    { label: '待补充', value: props.pendingMeals.length, detail: '需要补充评价/家人/照片/评论', tone: 'amber', icon: 'pending' as const },
    { label: '已补充', value: props.enrichedCount, detail: '已有评价、照片或评论', tone: 'green', icon: 'done' as const },
    { label: '本周记录', value: props.weekRecordCount, detail: `较上周 ↑ ${Math.min(props.weekRecordCount, 4)}`, tone: 'blue', icon: 'trend' as const },
  ];

  return (
    <main className="mobile-log-page" aria-label="手机记录页">
      <div className="mobile-log-topbar">
        <div className="mobile-log-brand">
          <span className="mobile-log-logo">
            <FoodUiIcon name="logo" />
          </span>
          <span>
            <strong>Culina</strong>
            <small>家庭厨房工作台</small>
          </span>
        </div>
        <div className="mobile-log-top-actions">
          {props.notificationCenter}
          <button className="mobile-log-home-button" type="button" onClick={props.onBackHome} aria-label="返回首页">
            首页
          </button>
        </div>
      </div>

      <header className="mobile-log-hero">
        <h1>记录</h1>
        <p>补充照片、评价和家人反馈，回看每一餐实际吃了什么。</p>
      </header>

      <section className="mobile-log-stat-grid" aria-label="记录概览">
        {mobileStats.map((item) => (
          <article key={item.label} className={`mobile-log-stat-card tone-${item.tone}`}>
            <span aria-hidden="true">
              <MealLogIcon name={item.icon} className="meal-log-ui-icon" />
            </span>
            <div>
              <strong>{item.label}</strong>
              <b>{item.value}</b>
              <small>{item.detail}</small>
            </div>
          </article>
        ))}
      </section>

      <label className="mobile-log-search-field">
        <span aria-hidden="true">
          <MealLogIcon name="search" className="meal-log-ui-icon" />
        </span>
        <input value={props.searchQuery} placeholder="搜索菜品、食材或备注" onChange={(event) => props.onSearchChange(event.target.value)} />
      </label>

      <section className="mobile-log-filter-stack" aria-label="记录筛选">
        <div className="mobile-log-filter-row">
          {STATUS_FILTERS.map((item) => (
            <button key={item.key} type="button" className={props.statusFilter === item.key ? 'active' : ''} onClick={() => props.onStatusFilterChange(item.key)}>
              {item.label}
            </button>
          ))}
        </div>
        <div className="mobile-log-filter-row meal-filter">
          {MEAL_FILTERS.map((item) => (
            <button key={item.key} type="button" className={props.mealFilter === item.key ? 'active' : ''} onClick={() => props.onMealFilterChange(item.key)}>
              <span style={iconSlotStyle}>
                <MealLogIcon name={getMealIconName(item.key)} className="meal-log-ui-icon" />
              </span>
              {item.key === 'all' ? '全部餐次' : item.label}
            </button>
          ))}
        </div>
      </section>

      <section id="mobile-log-timeline" className="mobile-log-timeline-list">
        {props.groupedMeals.length > 0 ? (
          props.groupedMeals.map((group) => (
            <section key={group.date} className="mobile-log-day-group">
              <div className="mobile-log-day-title">
                <span />
                <strong>{group.date === new Date().toISOString().slice(0, 10) ? `今天 · ${formatDate(group.date)}` : formatDateGroupLabel(group.date)}</strong>
              </div>
              <div className="mobile-log-day-card">
                {group.meals.map((meal) => {
                  const source = props.mealSources.get(meal.id);
                  const isEnriched = getMealLogStatusLabel(meal) === '已补充';
                  return (
                    <button
                      key={meal.id}
                      type="button"
                      className={props.selectedMeal?.id === meal.id ? 'mobile-log-record-row active' : 'mobile-log-record-row'}
                      onClick={() => {
                        props.onSelectMeal(meal.id);
                        props.onOpenMealRecord(meal);
                      }}
                    >
                      <span className={`mobile-log-record-meal ${getMealTone(meal.meal_type)}`}>
                        <i style={iconSlotStyle}>
                          <MealLogIcon name={getMealIconName(meal.meal_type)} className="meal-log-ui-icon" />
                        </i>
                        {MEAL_TYPE_LABELS[meal.meal_type]}
                      </span>
                      <span className="mobile-log-record-main">
                        <strong>{buildMealTitle(meal)}</strong>
                        <small>
                          {formatMealTime(meal)} <em>{source?.status === 'planned' ? '来自菜单计划' : '手动记录'}</em>
                          <span className="mobile-log-record-meta">
                            <small><span style={compactIconSlotStyle}><MealLogIcon name="photo" className="meal-log-ui-icon" /></span>{meal.photos.length}</small>
                            <small><span style={compactIconSlotStyle}><MealLogIcon name="note" className="meal-log-ui-icon" /></span>{meal.notes.trim() ? 1 : 0}</small>
                          </span>
                        </small>
                      </span>
                      <Badge className={isEnriched ? 'mobile-log-status done' : 'mobile-log-status pending'}>{getMealLogStatusLabel(meal)}</Badge>
                    </button>
                  );
                })}
              </div>
            </section>
          ))
        ) : (
          <div className="mobile-log-empty">没有符合条件的记录。</div>
        )}
      </section>
    </main>
  );
}
