import { useEffect, useMemo, useState, type ReactNode } from 'react';
import type { Food, FoodPlanItem, MealInsight, MealLog, Member, UpdateMealLogPayload } from '../../api/types';
import {
  ActionButton,
  FormActions,
  PageHeader,
  StateBlock,
  WorkspaceModal,
  WorkspaceOverlayFrame,
} from '../../components/ui-kit';
import { MEAL_TYPE_LABELS } from '../../lib/ui';
import { MealCompositionEditor } from './MealCompositionEditor';
import { MealDetailPreview } from './MealDetailPreview';
import { MealEnrichmentModal } from './MealEnrichmentModal';
import { MealHistorySurface } from './MealHistorySurface';
import { MealInlineRating } from './MealInlineRating';
import { MealPhotoLightbox } from './MealLogEnrichment';
import { MealLogIcon } from './MealLogIcons';
import {
  MealLogMobileView,
  MealTimelineFacts,
  MealTimelineMedia,
  buildMealTimelineRowModel,
} from './MealLogMobileView';
import { MealMemoryStrip, type MealMemoryStripStatus } from './MealMemoryStrip';
import { MealRecordResultBar } from './MealRecordResultBar';
import {
  MEAL_FILTERS,
  buildMealLogWorkspaceViewModel,
  buildMealTitle,
  formatDateGroupLabel,
  formatMealTime,
  getMealIconName,
  getMealTone,
  selectInitialMeal,
  type MealLogMealFilter,
} from './MealLogWorkspaceModel';
import type { MealRecordResult } from './useMealRecordResultState';

type Props = {
  foodPlanItems: FoodPlanItem[];
  members: Member[];
  recentMeals: MealLog[];
  foods?: Food[];
  mealInsights?: MealInsight[];
  mealInsightsStatus?: MealMemoryStripStatus;
  onRetryMealInsights?: () => void;
  isUpdatingMeal: boolean;
  notificationCenter?: ReactNode;
  /** When set, select this meal log (e.g. meal-detail eat task). */
  focusMealLogId?: string | null;
  updateMealLog: (mealLogId: string, payload: UpdateMealLogPayload) => Promise<unknown>;
  onBackHome: () => void;
  onBackToEat: () => void;
  onRecordMeal?: () => void;
  /** Shared Task 11 result; History only renders, does not own mutations. */
  recordResult?: MealRecordResult | null;
  isRevertingRecord?: boolean;
  recordRevertError?: string | null;
  recordRateError?: string | null;
  onRevertRecord?: () => void | Promise<void>;
  onViewRecord?: () => void;
  onRateRecord?: (rating: number | null | undefined) => void | Promise<void>;
  onDismissRecord?: () => void;
  updateMealComposition?: (
    mealLogId: string,
    payload: import('../../api/types').UpdateMealCompositionPayload,
  ) => Promise<MealLog>;
  refetchMealLog?: (mealLogId: string) => Promise<MealLog | null>;
};

type MealLogModalMode = 'detail' | 'enrich' | 'composition' | null;

export function MealLogWorkspace(props: Props) {
  const initialMealId = selectInitialMeal(props.recentMeals)?.id ?? null;
  const [selectedMealId, setSelectedMealId] = useState<string | null>(initialMealId);
  const [modalMode, setModalMode] = useState<MealLogModalMode>(null);
  const [activePreviewPhotoId, setActivePreviewPhotoId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [mealFilter, setMealFilter] = useState<MealLogMealFilter>('all');
  const [inlineRateError, setInlineRateError] = useState<string | null>(null);

  const foodsById = useMemo(
    () => new Map((props.foods ?? []).map((food) => [food.id, food])),
    [props.foods],
  );
  const membersById = useMemo(
    () => new Map(props.members.map((member) => [member.id, member])),
    [props.members],
  );

  const viewModel = useMemo(
    () =>
      buildMealLogWorkspaceViewModel({
        recentMeals: props.recentMeals,
        members: props.members,
        selectedMealId,
        searchQuery,
        mealFilter,
      }),
    [props.recentMeals, props.members, selectedMealId, searchQuery, mealFilter],
  );
  const activePreviewPhoto =
    viewModel.selectedMeal?.photos.find((photo) => photo.id === activePreviewPhotoId) ?? null;
  const mealEnrichmentFormId = 'meal-log-enrichment-overlay-form';

  useEffect(() => {
    if (!selectedMealId && viewModel.selectedMeal) {
      setSelectedMealId(viewModel.selectedMeal.id);
    }
  }, [selectedMealId, viewModel.selectedMeal?.id]);

  useEffect(() => {
    if (!props.focusMealLogId) return;
    if (!props.recentMeals.some((meal) => meal.id === props.focusMealLogId)) return;
    setSelectedMealId(props.focusMealLogId);
  }, [props.focusMealLogId, props.recentMeals]);

  function openMealRecord(meal: MealLog) {
    setSelectedMealId(meal.id);
    setModalMode('detail');
  }

  const resultBar =
    props.recordResult != null ? (
      <MealRecordResultBar
        result={props.recordResult}
        isReverting={props.isRevertingRecord}
        revertError={props.recordRevertError}
        rateError={props.recordRateError}
        onRevert={props.onRevertRecord}
        onView={props.onViewRecord}
        onRate={props.onRateRecord}
        onDismiss={props.onDismissRecord}
      />
    ) : null;

  const memoryStrip = (
    <MealMemoryStrip
      insights={props.mealInsights ?? []}
      status={props.mealInsightsStatus ?? 'idle'}
      onRetry={() => props.onRetryMealInsights?.()}
    />
  );

  const desktopTimeline = (
    <main className="meal-log-desktop-view meal-log-center-page">
      <PageHeader
        variant="compact"
        title="吃过的"
        description="回看家里吃过什么，随时记一餐。"
        actions={
          <div className="meal-log-header-actions">
            <ActionButton
              tone="primary"
              type="button"
              onClick={() => props.onRecordMeal?.()}
            >
              记一餐
            </ActionButton>
            <ActionButton tone="secondary" type="button" onClick={props.onBackToEat}>
              返回吃什么
            </ActionButton>
          </div>
        }
      />

      {resultBar}

      <div className="meal-log-memory-slot" data-memory-slot="true">
        {memoryStrip}
      </div>

      <section className="card meal-log-record-panel">
        <div className="meal-log-filter-bar">
          <label className="meal-log-search">
            <span>
              <MealLogIcon name="search" />
            </span>
            <input
              value={searchQuery}
              placeholder="搜索菜品或备注"
              onChange={(event) => setSearchQuery(event.target.value)}
            />
          </label>
          <div className="meal-log-meal-filter" aria-label="餐别筛选">
            {MEAL_FILTERS.map((item) => (
              <button
                key={item.key}
                type="button"
                className={mealFilter === item.key ? 'active' : ''}
                onClick={() => setMealFilter(item.key)}
              >
                <span className="meal-log-icon-slot">
                  <MealLogIcon name={getMealIconName(item.key)} />
                </span>
                {item.label}
              </button>
            ))}
          </div>
        </div>

        <div className="meal-log-timeline-head">
          <div>
            <h2>家庭时间线</h2>
            <span>按记录时间倒序展示</span>
          </div>
          <small>
            {viewModel.groupedMeals.reduce((total, group) => total + group.meals.length, 0)} 条记录
          </small>
        </div>

        {viewModel.groupedMeals.length > 0 ? (
          <div className="meal-log-record-timeline">
            {viewModel.groupedMeals.map((group) => (
              <section key={group.date} className="meal-log-day-group">
                <div className="meal-log-day-label">
                  <span />
                  <div>
                    <strong>{formatDateGroupLabel(group.date)}</strong>
                    <small>{group.meals.length} 条</small>
                  </div>
                </div>
                <div className="meal-log-record-list">
                  {group.meals.map((meal) => {
                    const row = buildMealTimelineRowModel({
                      meal,
                      foodsById,
                      membersById,
                    });
                    const isSelected = viewModel.selectedMeal?.id === meal.id;
                    const showInlineRating =
                      props.recordResult?.mealLogId === meal.id && props.recordResult.canRate;
                    // Always rate the result-linked meal (prefer full mealLog on result for row_version).
                    const ratingMeal =
                      props.recordResult?.mealLogId === meal.id
                        ? props.recordResult.mealLog ?? meal
                        : meal;
                    return (
                      <div key={meal.id} className="meal-log-record-block">
                        <button
                          type="button"
                          className={isSelected ? 'meal-log-record-row active' : 'meal-log-record-row'}
                          onClick={() => openMealRecord(meal)}
                        >
                          <MealTimelineMedia
                            title={row.title}
                            mealPhoto={row.mealPhoto}
                            foods={row.foods}
                            extraPhotoCount={row.extraPhotoCount}
                          />
                          <span className={`meal-log-meal-pill ${getMealTone(meal.meal_type)}`}>
                            <span className="meal-log-icon-slot">
                              <MealLogIcon name={getMealIconName(meal.meal_type)} />
                            </span>
                            {MEAL_TYPE_LABELS[meal.meal_type]}
                          </span>
                          <span className="meal-log-record-main">
                            <strong>{row.title}</strong>
                            <span className="meal-log-record-subline">
                              <time>{formatMealTime(meal)}</time>
                              <MealTimelineFacts
                                ratingValue={row.ratingValue}
                                participantCount={row.participantCount}
                                mediaCount={row.mediaCount}
                                recorderName={row.recorderName}
                              />
                            </span>
                          </span>
                        </button>
                        {showInlineRating && ratingMeal ? (
                          <MealInlineRating
                            meal={ratingMeal}
                            busy={props.isUpdatingMeal}
                            error={inlineRateError}
                            onRate={async (payload) => {
                              setInlineRateError(null);
                              try {
                                await props.updateMealLog(ratingMeal.id, payload);
                              } catch (reason) {
                                setInlineRateError(
                                  reason instanceof Error ? reason.message : '评分失败，请重试',
                                );
                                throw reason;
                              }
                            }}
                          />
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              </section>
            ))}
          </div>
        ) : (
          <StateBlock
            status="empty"
            title="没有符合条件的记录"
            description="换一个搜索词，或记一餐。"
            className="meal-log-empty-panel"
          />
        )}
      </section>
    </main>
  );

  const resultMeal =
    props.recordResult != null
      ? props.recordResult.mealLog ??
        props.recentMeals.find((meal) => meal.id === props.recordResult?.mealLogId) ??
        null
      : null;
  const showResultInlineRating = Boolean(props.recordResult?.canRate && resultMeal);

  const mobileTimeline = (
    <MealLogMobileView
      selectedMeal={viewModel.selectedMeal}
      groupedMeals={viewModel.groupedMeals}
      searchQuery={searchQuery}
      mealFilter={mealFilter}
      foodsById={foodsById}
      membersById={membersById}
      onSelectMeal={setSelectedMealId}
      onOpenMealRecord={openMealRecord}
      onBackHome={props.onBackHome}
      onSearchChange={setSearchQuery}
      onMealFilterChange={setMealFilter}
      onRecordMeal={props.onRecordMeal}
      notificationCenter={props.notificationCenter}
      resultBar={resultBar}
      memoryStrip={memoryStrip}
      inlineRatingMeal={showResultInlineRating ? resultMeal : null}
      isUpdatingMeal={props.isUpdatingMeal}
      inlineRateError={inlineRateError}
      onInlineRate={
        resultMeal
          ? async (payload) => {
              setInlineRateError(null);
              try {
                await props.updateMealLog(resultMeal.id, payload);
              } catch (reason) {
                setInlineRateError(
                  reason instanceof Error ? reason.message : '评分失败，请重试',
                );
                throw reason;
              }
            }
          : undefined
      }
    />
  );

  return (
    <>
      <MealHistorySurface mode="timeline" meal={viewModel.selectedMeal}>
        {mobileTimeline}
        {desktopTimeline}
      </MealHistorySurface>

      {modalMode === 'detail' && viewModel.selectedMeal ? (
        <WorkspaceOverlayFrame onClose={() => setModalMode(null)}>
          <WorkspaceModal
            title="这餐详情"
            description="查看这次用餐的内容与记录"
            eyebrow="餐食记录"
            className="meal-log-modal meal-log-preview-modal"
            onClose={() => setModalMode(null)}
            footerActions={
              <FormActions
                className="meal-log-preview-modal-actions"
                primaryLabel="编辑这顿"
                onPrimary={() => setModalMode('enrich')}
              >
                {props.updateMealComposition ? (
                  <ActionButton
                    tone="secondary"
                    type="button"
                    onClick={() => setModalMode('composition')}
                  >
                    调整组合
                  </ActionButton>
                ) : null}
              </FormActions>
            }
          >
            <MealDetailPreview
              meal={viewModel.selectedMeal}
              foods={props.foods ?? []}
              participantMembers={viewModel.selectedParticipantMembers}
              members={props.members}
              onOpenPhoto={setActivePreviewPhotoId}
            />
          </WorkspaceModal>
        </WorkspaceOverlayFrame>
      ) : null}

      {modalMode === 'enrich' ? (
        <MealEnrichmentModal
          open
          meal={viewModel.selectedMeal}
          members={props.members}
          isUpdating={props.isUpdatingMeal}
          updateMealLog={props.updateMealLog}
          onClose={() => setModalMode(null)}
          formId={mealEnrichmentFormId}
        />
      ) : null}

      {modalMode === 'composition' && viewModel.selectedMeal && props.updateMealComposition ? (
        <WorkspaceOverlayFrame onClose={() => setModalMode(null)}>
          <WorkspaceModal
            title="调整组合"
            description="添加或移除这顿包含的食物"
            className="meal-log-modal meal-log-composition-modal"
            onClose={() => setModalMode(null)}
          >
            <MealCompositionEditor
              meal={viewModel.selectedMeal}
              availableFoods={props.foods ?? []}
              busy={props.isUpdatingMeal}
              onSubmit={(payload) => props.updateMealComposition!(viewModel.selectedMeal!.id, payload)}
              onRefetchMeal={
                props.refetchMealLog
                  ? () => props.refetchMealLog!(viewModel.selectedMeal!.id)
                  : undefined
              }
              onSaved={() => setModalMode('detail')}
              onClose={() => setModalMode(null)}
            />
          </WorkspaceModal>
        </WorkspaceOverlayFrame>
      ) : null}

      {activePreviewPhoto && viewModel.selectedMeal && (
        <MealPhotoLightbox
          photo={activePreviewPhoto}
          title={buildMealTitle(viewModel.selectedMeal)}
          onClose={() => setActivePreviewPhotoId(null)}
        />
      )}
    </>
  );
}
