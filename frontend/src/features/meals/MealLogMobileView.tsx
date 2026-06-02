import type { MealLog } from '../../api/types';
import { Badge } from '../../components/ui-kit';
import { formatDate, MEAL_TYPE_LABELS } from '../../lib/ui';
import type { MealSource } from './MealLogEnrichment';
import {
  MEAL_FILTERS,
  STATUS_FILTERS,
  buildMealTitle,
  formatDateGroupLabel,
  formatMealTime,
  getMealIcon,
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
};

export function MealLogMobileView(props: Props) {
  const mobileStats = [
    { label: '今日已记录', value: props.todayMealCount, detail: '来自计划记录', tone: 'orange', icon: '□' },
    { label: '待补充', value: props.pendingMeals.length, detail: '需要补充评价/家人/照片/评论', tone: 'amber', icon: '✎' },
    { label: '已补充', value: props.enrichedCount, detail: '已有评价、照片或评论', tone: 'green', icon: '✓' },
    { label: '本周记录', value: props.weekRecordCount, detail: `较上周 ↑ ${Math.min(props.weekRecordCount, 4)}`, tone: 'blue', icon: '▥' },
  ];

  return (
    <main className="mobile-log-page" aria-label="手机记录页">
      <div className="mobile-dashboard-topbar mobile-log-topbar">
        <div className="mobile-dashboard-brand">
          <span className="mobile-dashboard-logo" aria-hidden="true">记</span>
          <span>
            <strong>餐食记录</strong>
            <small>评价、照片和家人反馈</small>
          </span>
        </div>
        <div className="mobile-dashboard-icon-actions">
          <button type="button" onClick={props.onBackHome} aria-label="返回首页">首页</button>
        </div>
      </div>

      <section className="mobile-log-stat-grid" aria-label="记录概览">
        {mobileStats.map((item) => (
          <article key={item.label} className={`mobile-log-stat-card tone-${item.tone}`}>
            <span aria-hidden="true">{item.icon}</span>
            <div>
              <strong>{item.label}</strong>
              <b>{item.value}</b>
              <small>{item.detail}</small>
            </div>
          </article>
        ))}
      </section>

      <label className="mobile-log-search-field">
        <span aria-hidden="true">⌕</span>
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
              <span>{item.key === 'all' ? '▦' : getMealIcon(item.key)}</span>
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
                        <i>{getMealIcon(meal.meal_type)}</i>
                        {MEAL_TYPE_LABELS[meal.meal_type]}
                      </span>
                      <span className="mobile-log-record-main">
                        <strong>{buildMealTitle(meal)}</strong>
                        <small>{formatMealTime(meal)} <em>{source?.status === 'planned' ? '来自菜单计划' : '手动记录'}</em></small>
                      </span>
                      <Badge className={isEnriched ? 'mobile-log-status done' : 'mobile-log-status pending'}>{getMealLogStatusLabel(meal)}</Badge>
                      <span className="mobile-log-record-meta">
                        <small>▧ {meal.photos.length}</small>
                        <small>○ {meal.notes.trim() ? 1 : 0}</small>
                      </span>
                      <span className="mobile-log-record-action">{isEnriched ? '查看详情' : '补充记录'}</span>
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
