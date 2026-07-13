import type { ReactNode } from 'react';
import type { MealLog } from '../../api/types';
import { StateBlock, StatusBadge } from '../../components/ui-kit';
import { FoodUiIcon } from '../../components/foods/FoodWorkspacePrimitives';
import { MEAL_TYPE_LABELS } from '../../lib/ui';
import type { MealSource } from './MealLogEnrichment';
import { MealLogIcon } from './MealLogIcons';
import {
  MEAL_FILTERS,
  STATUS_FILTERS,
  buildMealTitle,
  formatDateGroupLabel,
  formatMealTime,
  getMealIconName,
  getMealLogStatus,
  getMealLogStatusLabel,
  getMealRecordPresentation,
  getMealTone,
  type MealLogMealFilter,
  type MealLogStatusFilter,
} from './MealLogWorkspaceModel';

type Props = {
  basicMeals: MealLog[];
  selectedMeal: MealLog | null;
  mealSources: Map<string, MealSource>;
  todayMealCount: number;
  enrichedCount: number;
  weekRecordCount: number;
  totalRecordCount: number;
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

export function MealLogMobileView(props: Props) {
  const mobileStats = [
    { label: '今日已记录', value: props.todayMealCount, detail: '来自计划与手动记录', tone: 'orange', icon: 'today' as const },
    { label: '基础记录', value: props.basicMeals.length, detail: '可补充评价、家人、照片或评论', tone: 'amber', icon: 'pending' as const },
    { label: '已丰富', value: props.enrichedCount, detail: '已有评价、照片或评论', tone: 'green', icon: 'done' as const },
    { label: '本周记录', value: props.weekRecordCount, detail: `共 ${props.totalRecordCount} 条历史`, tone: 'blue', icon: 'trend' as const },
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
        <p>回看每一餐实际吃了什么，需要时再补充照片、评价和家人反馈。</p>
      </header>

      <section className="mobile-log-stat-grid" aria-label="记录概览">
        {mobileStats.map((item) => (
          <article key={item.label} className={`mobile-log-stat-card tone-${item.tone}`}>
            <span aria-hidden="true">
              <MealLogIcon name={item.icon} />
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
          <MealLogIcon name="search" />
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
              <span className="meal-log-icon-slot">
                <MealLogIcon name={getMealIconName(item.key)} />
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
                <strong>{formatDateGroupLabel(group.date)}</strong>
              </div>
              <div className="mobile-log-day-card">
                {group.meals.map((meal) => {
                  const source = props.mealSources.get(meal.id);
                  const mealStatus = getMealLogStatus(meal);
                  const mealStatusLabel = getMealLogStatusLabel(meal);
                  const presentation = getMealRecordPresentation(meal);
                  const isEnriched = mealStatus === 'done';
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
                        <i className="meal-log-icon-slot">
                          <MealLogIcon name={getMealIconName(meal.meal_type)} />
                        </i>
                        {MEAL_TYPE_LABELS[meal.meal_type]}
                      </span>
                      <span className="mobile-log-record-main">
                        <strong>{buildMealTitle(meal)}</strong>
                        <small>
                          {formatMealTime(meal)} <em>{source?.status === 'planned' ? '来自菜单计划' : '手动记录'}</em>
                          <span className="mobile-log-record-meta">
                            <small><span className="meal-log-icon-slot compact"><MealLogIcon name="photo" /></span>{meal.photos.length}</small>
                            <small><span className="meal-log-icon-slot compact"><MealLogIcon name="note" /></span>{meal.notes.trim() ? 1 : 0}</small>
                          </span>
                        </small>
                      </span>
                      <StatusBadge tone={isEnriched ? 'success' : 'neutral'} size="compact" className={isEnriched ? 'mobile-log-status done' : 'mobile-log-status pending'}>
                        {mealStatusLabel}
                      </StatusBadge>
                      <span className="sr-only">{presentation.actionLabel}</span>
                    </button>
                  );
                })}
              </div>
            </section>
          ))
        ) : (
          <StateBlock
            status="empty"
            title="没有符合条件的记录"
            description="换一个筛选条件，或先补录一餐。"
            className="mobile-log-empty"
          />
        )}
      </section>
    </main>
  );
}
