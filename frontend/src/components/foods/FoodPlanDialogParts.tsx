import type { CompositionEvent, ReactNode } from 'react';
import type { Food, MealType } from '../../api/types';
import { MediaWithPlaceholder } from '../MediaPlaceholder';
import { SearchableResourceSelect } from '../ui-kit';
import { FoodUiIcon } from './FoodWorkspacePrimitives';

export type FoodPlanDateOption = {
  value: string;
  label: string;
  display: string;
};

export type FoodPlanMealOption = {
  value: MealType;
  label: string;
};

export function FoodPlanSelectedHero(props: {
  food: Food;
  coverUrl?: string;
  coverSrcSet?: string;
  coverSizes?: string;
  typeLabel: string;
  sourceLabel: string;
  capabilityLabel: string;
  iconKind: 'bookOpen' | 'clipboard';
  disabled?: boolean;
  onClear: () => void;
}) {
  return (
    <div className="recipe-plan-dialog-hero">
      <div className="recipe-plan-selected-cover">
        <MediaWithPlaceholder
          src={props.coverUrl}
          srcSet={props.coverSrcSet}
          sizes={props.coverSizes}
          alt={props.food.name}
        />
      </div>
      <div className="recipe-plan-selected-copy">
        <span className="recipe-plan-dialog-kicker">即将加入</span>
        <strong>{props.food.name}</strong>
        <div className="recipe-plan-selected-meta">
          <span>
            <FoodUiIcon name="home" />
            {props.typeLabel}
          </span>
          <span>
            <FoodUiIcon name="cloche" />
            {props.sourceLabel}
          </span>
          <span>
            <FoodUiIcon name={props.iconKind} />
            {props.capabilityLabel}
          </span>
        </div>
      </div>
      <button className="recipe-plan-change-food" type="button" onClick={props.onClear} disabled={props.disabled}>
        修改
      </button>
      <FoodUiIcon name="cloche" className="recipe-plan-selected-ornament" />
    </div>
  );
}

export function FoodPlanFoodPicker(props: {
  searchInputId: string;
  value: string;
  query: string;
  loading: boolean;
  loadingMore: boolean;
  hasMore: boolean;
  disabled?: boolean;
  options: Array<{ id: string; label: string; description: string; image: ReactNode }>;
  emptyText: string;
  onCompositionStart: (event: CompositionEvent<HTMLInputElement>) => void;
  onCompositionEnd: (event: CompositionEvent<HTMLInputElement>) => void;
  onQueryChange: (value: string) => void;
  onLoadMore: () => void;
  onChange: (foodId: string) => void;
}) {
  return (
    <div className="recipe-plan-picker">
      <label htmlFor={props.searchInputId}>选择食物</label>
      <SearchableResourceSelect
        searchInputId={props.searchInputId}
        ariaLabel="选择食物"
        placeholder="搜索食物、来源、场景或备注"
        value={props.value}
        query={props.query}
        presentation="popover"
        loading={props.loading}
        loadingMore={props.loadingMore}
        hasMore={props.hasMore}
        disabled={props.disabled}
        loadMoreText="加载更多食物"
        loadingMoreText="正在加载更多食物..."
        options={props.options}
        emptyText={props.emptyText}
        onSearchCompositionStart={props.onCompositionStart}
        onSearchCompositionEnd={props.onCompositionEnd}
        onQueryChange={props.onQueryChange}
        onLoadMore={props.onLoadMore}
        onChange={props.onChange}
      />
    </div>
  );
}

export function FoodPlanDateMealNoteFields(props: {
  planDate: string;
  mealType: MealType;
  note: string;
  todayDate: string;
  planDateOptions: FoodPlanDateOption[];
  mealOptions: FoodPlanMealOption[];
  notePlaceholder: string;
  disabled?: boolean;
  onPlanDateChange: (date: string) => void;
  onMealTypeChange: (mealType: MealType) => void;
  onPlanNoteChange: (note: string) => void;
}) {
  return (
    <>
      <div className="recipe-plan-form-row">
        <label className="recipe-plan-date-field">
          <span>计划日期</span>
          <div className="recipe-plan-date-strip" role="radiogroup" aria-label="计划日期">
            {props.planDateOptions.map((date) => (
              <button
                key={date.value}
                type="button"
                className={props.planDate === date.value ? 'active' : ''}
                aria-pressed={props.planDate === date.value}
                disabled={props.disabled}
                onClick={() => props.onPlanDateChange(date.value)}
              >
                <span>{date.value === props.todayDate ? '今天' : date.label}</span>
                <strong>{date.display}</strong>
              </button>
            ))}
          </div>
        </label>
        <label className="recipe-plan-meal-field">
          <span>餐次</span>
          <div className="recipe-plan-meal-segment" role="radiogroup" aria-label="餐次">
            {props.mealOptions.map((item) => (
              <button
                key={item.value}
                type="button"
                className={props.mealType === item.value ? 'active' : ''}
                aria-pressed={props.mealType === item.value}
                disabled={props.disabled}
                onClick={() => props.onMealTypeChange(item.value)}
              >
                {item.label}
              </button>
            ))}
          </div>
        </label>
      </div>
      <label className="recipe-plan-note-field">
        <span>备注</span>
        <input
          className="text-input"
          value={props.note}
          placeholder={props.notePlaceholder}
          disabled={props.disabled}
          onChange={(event) => props.onPlanNoteChange(event.target.value)}
        />
      </label>
    </>
  );
}
