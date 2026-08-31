import type { ComponentProps, RefObject } from 'react';
import type { Food, FoodScene } from '../../api/types/food';
import { buildMediaSrcSet, resolveMediaUrl } from '../../lib/assets';
import { ActionButton, EmptyState } from '../ui-kit';
import { FoodHubView } from './FoodHubView';
import { FoodLibraryFilters } from './FoodLibraryFilters';
import { FoodDesktopSidebar } from './FoodDesktopSidebar';
import { FoodTabletSupportSurface } from './FoodTabletSupportSurface';
import { FoodCardLibrary, type FoodLibraryCardActions, type FoodLibraryCardViewModel } from './FoodLibraryCard';
import type { FoodPlanSurfaceProps } from './FoodPlanSurface';
import type { FoodSceneCardView } from './useFoodSceneState';
import type { FoodGovernanceIssue } from './FoodWorkspaceOptions';
import { FoodUiIcon } from './FoodWorkspacePrimitives';
import { resolveFoodAssetUrl } from './FoodWorkspaceModel';
import { FoodMobileView } from './FoodMobileView';

type RepeatFood = { food: Food };
type GovernanceSummary = { value: FoodGovernanceIssue; label: string; count: number }[];

export type FoodWorkspaceDiscoverDesktopProps = {
  search: string;
  searchLoading: boolean;
  typeFilter: FoodLibraryFiltersProps['typeFilter'];
  mealFilter: FoodLibraryFiltersProps['mealFilter'];
  lensFilter: string;
  governanceIssueFilter: 'all' | FoodGovernanceIssue;
  hasFoodFilters: boolean;
  filteredFoods: Food[];
  totalFoods: number;
  governanceQueueLength: number;
  needsInfoCount: number;
  nextGovernanceSummary: string;
  governanceIssueSummaries: GovernanceSummary;
  feedback: string | null;
  currentLensCopy: { emptyTitle: string; emptyDescription: string };
  foodCardViewModels: FoodLibraryCardViewModel[];
  foodCardResetKey: string;
  foodLibraryCardActionsRef: RefObject<FoodLibraryCardActions>;
  repeatFoods: RepeatFood[];
  repeatFoodCount: number;
  managementIssueCount: number;
  foodScenes: FoodScene[];
  sceneCards: FoodSceneCardView[];
  sceneFilter: string;
  nextGovernanceFood: Food | null;
  planSurfaceProps: FoodPlanSurfaceProps;
  onCreateFood: (type: 'takeout' | 'selfMade') => void;
  onOpenLogs: () => void;
  onSearchChange: (value: string) => void;
  onSearchClear: () => void;
  onSearchCompositionStart?: ComponentProps<'input'>['onCompositionStart'];
  onSearchCompositionEnd?: ComponentProps<'input'>['onCompositionEnd'];
  onTypeFilterChange: (value: FoodWorkspaceDiscoverDesktopProps['typeFilter']) => void;
  onMealFilterChange: (value: FoodWorkspaceDiscoverDesktopProps['mealFilter']) => void;
  onClearFilters: () => void;
  onOpenNextGovernanceFood: () => void;
  onGovernanceIssueChange: (issue: 'all' | FoodGovernanceIssue) => void;
  onSetLensFavorite: () => void;
  onSetLensExpiring: () => void;
  onOpenGovernanceIssue: () => void;
  onOpenSceneManager: () => void;
  onToggleScene: (name: string) => void;
  isUpdatingFavorite: boolean;
  isQuickAdding: boolean;
};

type FoodLibraryFiltersProps = ComponentProps<typeof FoodLibraryFilters>;

export function FoodWorkspaceDiscoverDesktop(props: FoodWorkspaceDiscoverDesktopProps) {
  const hasEmptyFilters = Boolean(props.search) || props.typeFilter !== 'all' || props.mealFilter !== 'all' || props.sceneFilter !== 'all';
  return (
    <FoodHubView
      heroActions={<div className="hero-actions">
        <ActionButton tone="primary" type="button" onClick={() => props.onCreateFood('takeout')}><FoodUiIcon name="plus" /><span>新增食物</span></ActionButton>
        <ActionButton tone="secondary" type="button" onClick={props.onOpenLogs}><FoodUiIcon name="receipt" /><span>用餐记录</span></ActionButton>
      </div>}
      filtersSection={<FoodLibraryFilters
        search={props.search} searchLoading={props.searchLoading} typeFilter={props.typeFilter} mealFilter={props.mealFilter}
        lensFilter={props.lensFilter} governanceIssueFilter={props.governanceIssueFilter} hasFoodFilters={props.hasFoodFilters}
        filteredCount={props.filteredFoods.length} totalCount={props.totalFoods} governanceQueueLength={props.governanceQueueLength}
        needsInfoCount={props.needsInfoCount} nextGovernanceSummary={props.nextGovernanceSummary} governanceIssueSummaries={props.governanceIssueSummaries}
        onSearchChange={props.onSearchChange} onSearchClear={props.onSearchClear} onSearchCompositionStart={props.onSearchCompositionStart ?? (() => undefined)}
        onSearchCompositionEnd={props.onSearchCompositionEnd ?? (() => undefined)} onTypeFilterChange={props.onTypeFilterChange} onMealFilterChange={props.onMealFilterChange}
        onClearFilters={props.onClearFilters} onOpenNextGovernanceFood={props.onOpenNextGovernanceFood} onGovernanceIssueChange={props.onGovernanceIssueChange}
      />}
      feedbackSection={props.feedback ? <div className="food-feedback"><span>{props.feedback}</span><button type="button" onClick={props.onOpenLogs}>查看记录</button></div> : null}
      gridSection={props.filteredFoods.length > 0 ? <FoodCardLibrary models={props.foodCardViewModels} resetKey={props.foodCardResetKey} actionsRef={props.foodLibraryCardActionsRef} isUpdatingFavorite={props.isUpdatingFavorite} isQuickAdding={props.isQuickAdding} /> : (
        <EmptyState title={props.currentLensCopy.emptyTitle} description={hasEmptyFilters ? '没有符合条件的食物，可以清空筛选后再试。' : props.currentLensCopy.emptyDescription}
          action={hasEmptyFilters ? <ActionButton tone="secondary" type="button" onClick={props.onClearFilters}>清空筛选</ActionButton> : props.lensFilter === 'selfMade' ? <ActionButton tone="primary" type="button" onClick={() => props.onCreateFood('selfMade')}>添加家常菜谱</ActionButton> : <ActionButton tone="primary" type="button" onClick={() => props.onCreateFood('takeout')}>新增食物</ActionButton>} />
      )}
      sidebar={<>
        <FoodDesktopSidebar repeatFoods={props.repeatFoods} repeatFoodCount={props.repeatFoodCount} managementIssueCount={props.managementIssueCount} needsInfoCount={props.needsInfoCount}
          foodScenes={props.foodScenes} sceneCards={props.sceneCards} sceneFilter={props.sceneFilter} nextGovernanceFood={props.nextGovernanceFood} nextGovernanceSummary={props.nextGovernanceSummary}
          plan={props.planSurfaceProps} onSetLensFavorite={props.onSetLensFavorite} onSetLensExpiring={props.onSetLensExpiring} onOpenGovernanceIssue={props.onOpenGovernanceIssue}
          onOpenSceneManager={props.onOpenSceneManager} onOpenNextGovernanceFood={props.onOpenNextGovernanceFood} onToggleScene={props.onToggleScene} />
        <FoodTabletSupportSurface metrics={[
          { label: '常吃清单', value: props.repeatFoodCount, title: props.repeatFoods.map(({ food }) => food.name).join('、') || '常吃清单', onClick: props.onSetLensFavorite },
          { label: '临期或需要完善信息', value: props.managementIssueCount, onClick: props.onSetLensExpiring },
          { label: '需要完善', value: props.needsInfoCount, onClick: props.onOpenGovernanceIssue },
          { label: '场景管理', value: props.foodScenes.filter((scene) => !scene.hidden).length, onClick: props.onOpenSceneManager },
        ]} nextTaskLabel={props.nextGovernanceFood ? '下一项需要完善' : '需要完善'} nextTaskSummary={props.nextGovernanceSummary} canOpenNextTask={Boolean(props.nextGovernanceFood)} onOpenNextTask={props.onOpenNextGovernanceFood}
          plan={props.planSurfaceProps} scenes={props.sceneCards.map((scene) => ({ name: scene.name, description: scene.description || (scene.count > 0 ? `${scene.count} 种食物` : '浏览这个场景'), imageUrl: resolveMediaUrl(scene.imageAsset, 'thumb') ?? (scene.imageUrl ? resolveFoodAssetUrl(scene.imageUrl) : undefined), imageSrcSet: buildMediaSrcSet(scene.imageAsset), active: props.sceneFilter === scene.name, onSelect: () => props.onToggleScene(scene.name) }))} />
      </>}
    />
  );
}

export type FoodWorkspaceDiscoverMobileProps = ComponentProps<typeof FoodMobileView>;

export function FoodWorkspaceDiscoverMobile(props: FoodWorkspaceDiscoverMobileProps) {
  return (
    <FoodMobileView
      recipes={props.recipes}
      mealLogs={props.mealLogs}
      managementIssueCount={props.managementIssueCount}
      mobileScenePages={props.mobileScenePages}
      mobileLibraryFoods={props.mobileLibraryFoods}
      mobileLibraryResetKey={props.mobileLibraryResetKey}
      hasFoodFilters={props.hasFoodFilters}
      search={props.search}
      isSearchFetching={props.isSearchFetching}
      emptyTitle={props.emptyTitle}
      isQuickAdding={props.isQuickAdding}
      isUpdatingFavorite={props.isUpdatingFavorite}
      notificationCenter={props.notificationCenter}
      weekPage={props.weekPage}
      resolveFoodAssetUrl={props.resolveFoodAssetUrl}
      getFoodCardPrimaryActionLabel={props.getFoodCardPrimaryActionLabel}
      getDefaultMealType={props.getDefaultMealType}
      getFoodSceneTags={props.getFoodSceneTags}
      getFoodCookingSummary={props.getFoodCookingSummary}
      onSearchChange={props.onSearchChange}
      onSearchCompositionStart={props.onSearchCompositionStart}
      onSearchCompositionEnd={props.onSearchCompositionEnd}
      onOpenGovernanceIssue={props.onOpenGovernanceIssue}
      onOpenSceneManager={props.onOpenSceneManager}
      onOpenDetail={props.onOpenDetail}
      onOpenPlanDialog={props.onOpenPlanDialog}
      onHandleFoodCardPrimaryAction={props.onHandleFoodCardPrimaryAction}
      onToggleFavorite={props.onToggleFavorite}
      onOpenShopping={props.onOpenShopping}
      onOpenCreate={props.onOpenCreate}
      onOpenLogs={props.onOpenLogs}
      onClearFoodFilters={props.onClearFoodFilters}
      filterTabs={props.filterTabs}
    />
  );
}
