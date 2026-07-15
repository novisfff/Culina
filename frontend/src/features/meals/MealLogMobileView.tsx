import type { ReactNode } from 'react';
import type { Food, MealLog, MediaAsset, Member, UpdateMealLogPayload } from '../../api/types';
import { MediaWithPlaceholder } from '../../components/MediaPlaceholder';
import { buildMediaSizes, buildMediaSrcSet, resolveMediaUrl } from '../../lib/assets';
import { MEAL_TYPE_LABELS } from '../../lib/ui';
import { MealInlineRating } from './MealInlineRating';
import { MealLogIcon } from './MealLogIcons';
import { selectMealPreviewMedia } from './MealComposerModel';
import {
  MEAL_FILTERS,
  buildMealTitle,
  formatDateGroupLabel,
  formatMealTime,
  getMealIconName,
  getMealMediaCount,
  getMealParticipantCount,
  getMealRatingValue,
  getMealTone,
  type MealLogMealFilter,
} from './MealLogWorkspaceModel';

export type MealTimelineRowModel = {
  meal: MealLog;
  title: string;
  preview: MediaAsset | null;
  extraPhotoCount: number;
  ratingValue: string | null;
  participantCount: number | null;
  mediaCount: number | null;
  recorderName: string | null;
};

export function buildMealTimelineRowModel(args: {
  meal: MealLog;
  foodsById: Map<string, Food>;
  membersById: Map<string, Member>;
}): MealTimelineRowModel {
  const foodCovers = args.meal.food_entries.map(
    (entry) => args.foodsById.get(entry.food_id)?.images?.[0] ?? null,
  );
  const preview = selectMealPreviewMedia({
    mealPhotos: args.meal.photos,
    foodCovers,
  });
  const extraPhotoCount = Math.max(0, args.meal.photos.length - 1);
  const recorderId = args.meal.created_by ?? args.meal.updated_by ?? null;
  const recorderName = recorderId ? args.membersById.get(recorderId)?.display_name ?? null : null;
  return {
    meal: args.meal,
    title: buildMealTitle(args.meal),
    preview,
    extraPhotoCount,
    ratingValue: getMealRatingValue(args.meal),
    participantCount: getMealParticipantCount(args.meal),
    mediaCount: getMealMediaCount(args.meal),
    recorderName,
  };
}

export function MealTimelineMedia(props: {
  title: string;
  preview: MediaAsset | null;
  extraPhotoCount: number;
  className?: string;
}) {
  return (
    <span className={['meal-log-row-media', props.className].filter(Boolean).join(' ')}>
      <MediaWithPlaceholder
        src={resolveMediaUrl(props.preview, 'thumb')}
        srcSet={buildMediaSrcSet(props.preview)}
        sizes={buildMediaSizes('thumb')}
        alt={props.preview?.alt || props.title}
        showLabel={false}
      />
      {props.extraPhotoCount > 0 ? <em className="meal-log-row-media-count">+{props.extraPhotoCount}</em> : null}
    </span>
  );
}

export function MealTimelineFacts(props: {
  ratingValue: string | null;
  participantCount: number | null;
  mediaCount: number | null;
  recorderName: string | null;
}) {
  const facts: string[] = [];
  if (props.ratingValue) facts.push(`★ ${props.ratingValue}`);
  if (props.participantCount) facts.push(`${props.participantCount} 人`);
  if (props.mediaCount) facts.push(`${props.mediaCount} 张照片`);
  if (props.recorderName) facts.push(props.recorderName);
  if (facts.length === 0) return null;
  return (
    <span className="meal-log-row-facts">
      {facts.map((fact) => (
        <span key={fact}>{fact}</span>
      ))}
    </span>
  );
}

type Props = {
  selectedMeal: MealLog | null;
  groupedMeals: Array<{ date: string; meals: MealLog[] }>;
  searchQuery: string;
  mealFilter: MealLogMealFilter;
  foodsById: Map<string, Food>;
  membersById: Map<string, Member>;
  onSelectMeal: (mealId: string) => void;
  onOpenMealRecord: (meal: MealLog) => void;
  onBackHome: () => void;
  onSearchChange: (value: string) => void;
  onMealFilterChange: (value: MealLogMealFilter) => void;
  onRecordMeal?: () => void;
  notificationCenter?: ReactNode;
  resultBar?: ReactNode;
  memoryStrip?: ReactNode;
  /** Result-linked meal for inline rating; must be that meal, not selectedMeal. */
  inlineRatingMeal?: MealLog | null;
  isUpdatingMeal?: boolean;
  inlineRateError?: string | null;
  onInlineRate?: (payload: UpdateMealLogPayload) => Promise<unknown>;
};

export function MealLogMobileView(props: Props) {
  return (
    <main className="mobile-log-page" aria-label="手机吃过的页面">
      <div className="mobile-log-topbar">
        <div className="mobile-log-brand">
          <strong>Culina</strong>
          <small>家庭厨房工作台</small>
        </div>
        <div className="mobile-log-top-actions">
          {props.notificationCenter}
          <button className="mobile-log-home-button" type="button" onClick={props.onBackHome} aria-label="返回首页">
            首页
          </button>
        </div>
      </div>

      <header className="mobile-log-hero">
        <div className="mobile-log-hero-copy">
          <h1>吃过的</h1>
          <p>回看家里吃过什么，需要时再补充照片、评价和家人反馈。</p>
        </div>
        <button
          className="mobile-log-primary-cta"
          type="button"
          onClick={() => props.onRecordMeal?.()}
        >
          记一餐
        </button>
      </header>

      {props.resultBar}

      <div className="mobile-log-memory-slot" data-memory-slot="true">
        {props.memoryStrip}
      </div>

      <label className="mobile-log-search-field">
        <span aria-hidden="true">
          <MealLogIcon name="search" />
        </span>
        <input
          value={props.searchQuery}
          placeholder="搜索菜品或备注"
          onChange={(event) => props.onSearchChange(event.target.value)}
        />
      </label>

      <section className="mobile-log-filter-stack" aria-label="餐别筛选">
        <div className="mobile-log-filter-row meal-filter">
          {MEAL_FILTERS.map((item) => (
            <button
              key={item.key}
              type="button"
              className={props.mealFilter === item.key ? 'active' : ''}
              onClick={() => props.onMealFilterChange(item.key)}
            >
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
                  const row = buildMealTimelineRowModel({
                    meal,
                    foodsById: props.foodsById,
                    membersById: props.membersById,
                  });
                  const showInlineRating = props.inlineRatingMeal?.id === meal.id && props.onInlineRate;
                  return (
                    <div key={meal.id} className="mobile-log-record-block">
                      <button
                        type="button"
                        className={
                          props.selectedMeal?.id === meal.id
                            ? 'mobile-log-record-row active'
                            : 'mobile-log-record-row'
                        }
                        onClick={() => {
                          props.onSelectMeal(meal.id);
                          props.onOpenMealRecord(meal);
                        }}
                      >
                        <MealTimelineMedia
                          title={row.title}
                          preview={row.preview}
                          extraPhotoCount={row.extraPhotoCount}
                          className="mobile-log-row-media"
                        />
                        <span className="mobile-log-record-main">
                          <strong>{row.title}</strong>
                          <small>
                            <span className={`mobile-log-record-meal ${getMealTone(meal.meal_type)}`}>
                              {MEAL_TYPE_LABELS[meal.meal_type]}
                            </span>
                            <time>{formatMealTime(meal)}</time>
                          </small>
                          <MealTimelineFacts
                            ratingValue={row.ratingValue}
                            participantCount={row.participantCount}
                            mediaCount={row.mediaCount}
                            recorderName={row.recorderName}
                          />
                        </span>
                      </button>
                      {showInlineRating ? (
                        <MealInlineRating
                          meal={props.inlineRatingMeal!}
                          busy={props.isUpdatingMeal}
                          error={props.inlineRateError}
                          onRate={props.onInlineRate!}
                        />
                      ) : null}
                    </div>
                  );
                })}
              </div>
            </section>
          ))
        ) : (
          <div className="mobile-log-empty">
            <strong>没有符合条件的记录</strong>
            <p>换一个搜索词，或记一餐。</p>
          </div>
        )}
      </section>
    </main>
  );
}
