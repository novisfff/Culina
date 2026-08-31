import type { CompositionEventHandler } from 'react';
import { OptionChipGroup, SearchField } from '../ui-kit';
import { FoodUiIcon } from './FoodWorkspacePrimitives';
import type { FoodType, MealType } from '../../api/types/food';
import {
  FOOD_TYPE_OPTIONS,
  MEAL_OPTIONS,
  type FoodGovernanceIssue,
} from './FoodWorkspaceOptions';

export type FoodLibraryFiltersProps = {
  search: string;
  searchLoading: boolean;
  typeFilter: FoodType | 'all';
  mealFilter: MealType | 'all';
  lensFilter: string;
  governanceIssueFilter: 'all' | FoodGovernanceIssue;
  hasFoodFilters: boolean;
  filteredCount: number;
  totalCount: number;
  governanceQueueLength: number;
  needsInfoCount: number;
  nextGovernanceSummary: string;
  governanceIssueSummaries: Array<{ value: FoodGovernanceIssue; label: string; count: number }>;
  onSearchChange: (value: string) => void;
  onSearchClear: () => void;
  onSearchCompositionStart: CompositionEventHandler<HTMLInputElement>;
  onSearchCompositionEnd: CompositionEventHandler<HTMLInputElement>;
  onTypeFilterChange: (value: FoodType | 'all') => void;
  onMealFilterChange: (value: MealType | 'all') => void;
  onClearFilters: () => void;
  onOpenNextGovernanceFood: () => void;
  onGovernanceIssueChange: (issue: 'all' | FoodGovernanceIssue) => void;
};

export function FoodLibraryFilters({
  search,
  searchLoading,
  typeFilter,
  mealFilter,
  lensFilter,
  governanceIssueFilter,
  hasFoodFilters,
  filteredCount,
  totalCount,
  governanceQueueLength,
  needsInfoCount,
  nextGovernanceSummary,
  governanceIssueSummaries,
  onSearchChange,
  onSearchClear,
  onSearchCompositionStart,
  onSearchCompositionEnd,
  onTypeFilterChange,
  onMealFilterChange,
  onClearFilters,
  onOpenNextGovernanceFood,
  onGovernanceIssueChange,
}: FoodLibraryFiltersProps) {
  return (
    <section className="food-filter-shell">
      <div className="food-library-main">
        <div className="food-library-head">
          <div className="workspace-toolbar-copy">
            <h3>食物库</h3>
          </div>
          <div className="food-library-search-row">
            <SearchField
              className="food-search-field"
              ariaLabel="搜索食物"
              placeholder="搜索食物、来源、口味或备注…"
              value={search}
              loading={searchLoading}
              leadingIcon={<FoodUiIcon name="search" />}
              onChange={onSearchChange}
              onClear={onSearchClear}
              onCompositionStart={onSearchCompositionStart}
              onCompositionEnd={onSearchCompositionEnd}
            />
            <div className="food-library-head-actions">
              <p className="workspace-toolbar-summary">显示 {filteredCount} / {totalCount} 项食物</p>
              {hasFoodFilters && (
                <button className="food-clear-filters-button" type="button" onClick={onClearFilters}>
                  <FoodUiIcon name="refresh" />
                  <span>清空筛选</span>
                </button>
              )}
            </div>
          </div>
        </div>
        <div className="food-toolbar-controls">
          <div className="food-filter-group">
            <span>类型</span>
            <OptionChipGroup
              ariaLabel="食物类型"
              size="small"
              className="food-filter-chip-group"
              options={[{ value: 'all', label: '全部' }, ...FOOD_TYPE_OPTIONS.map((item) => ({ value: item.value, label: item.label }))]}
              value={typeFilter}
              onChange={onTypeFilterChange}
            />
          </div>
          <div className="food-filter-group">
            <span>餐别</span>
            <OptionChipGroup
              ariaLabel="适合餐别"
              size="small"
              className="food-filter-chip-group"
              options={[{ value: 'all', label: '全餐别' }, ...MEAL_OPTIONS.map((item) => ({ value: item.value, label: item.label }))]}
              value={mealFilter}
              onChange={onMealFilterChange}
            />
          </div>
        </div>
        {lensFilter === 'needsInfo' && (
          <section className="food-governance-panel" aria-label="需要完善的信息">
            <div className="food-governance-head">
              <div>
                <span className="eyebrow">补充信息</span>
                <h4>{governanceQueueLength > 0 ? `还有 ${governanceQueueLength} 项食物需要完善信息` : '信息已补齐'}</h4>
                <p>{governanceQueueLength > 0 ? nextGovernanceSummary : '当前没有需要完善信息的食物。'}</p>
              </div>
              <button type="button" disabled={governanceQueueLength === 0} onClick={onOpenNextGovernanceFood}>
                下一条
              </button>
            </div>
            <OptionChipGroup
              ariaLabel="需要完善的类型"
              value={governanceIssueFilter}
              className="food-governance-options"
              options={[
                { value: 'all', label: '全部需要完善', description: `${needsInfoCount}` },
                ...governanceIssueSummaries.map((item) => ({
                  value: item.value,
                  label: item.label,
                  description: `${item.count}`,
                })),
              ]}
              onChange={onGovernanceIssueChange}
            />
          </section>
        )}
      </div>
    </section>
  );
}
