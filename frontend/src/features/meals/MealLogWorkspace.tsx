import { useEffect, useMemo, useState, type ReactNode } from 'react';
import type { FoodPlanItem, MealLog, Member, UpdateMealLogPayload } from '../../api/types';
import {
  Avatar,
  Badge,
  FormActions,
  OptionChipGroup,
  PageHeader,
  StateBlock,
  StatusBadge,
  WorkspaceModal,
  WorkspaceOverlayFrame,
} from '../../components/ui-kit';
import { MediaWithPlaceholder } from '../../components/MediaPlaceholder';
import { resolveAssetUrl } from '../../lib/assets';
import { formatDateTime, MEAL_TYPE_LABELS } from '../../lib/ui';
import { MealEnrichmentModal } from './MealEnrichmentModal';
import { MealHistorySurface } from './MealHistorySurface';
import { MealPhotoLightbox } from './MealLogEnrichment';
import { MealLogIcon } from './MealLogIcons';
import { MealLogMobileView } from './MealLogMobileView';
import {
  MEAL_FILTERS,
  STATUS_FILTERS,
  buildMealLogWorkspaceViewModel,
  buildMealTitle,
  formatDateGroupLabel,
  formatMealTime,
  getMealIconName,
  getMealLogStatus,
  getMealLogStatusLabel,
  getMealRecordPresentation,
  getMealRatingSummary,
  getMealTone,
  selectInitialMeal,
  type MealLogMealFilter,
  type MealLogStatusFilter,
} from './MealLogWorkspaceModel';

type Props = {
  foodPlanItems: FoodPlanItem[];
  members: Member[];
  recentMeals: MealLog[];
  isUpdatingMeal: boolean;
  notificationCenter?: ReactNode;
  updateMealLog: (mealLogId: string, payload: UpdateMealLogPayload) => Promise<unknown>;
  onBackHome: () => void;
};

type MealLogModalMode = 'enrich' | 'preview' | null;

export function MealLogWorkspace(props: Props) {
  const initialMealId = selectInitialMeal(props.recentMeals)?.id ?? null;
  const [selectedMealId, setSelectedMealId] = useState<string | null>(initialMealId);
  const [modalMode, setModalMode] = useState<MealLogModalMode>(null);
  const [activePreviewPhotoId, setActivePreviewPhotoId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<MealLogStatusFilter>('all');
  const [mealFilter, setMealFilter] = useState<MealLogMealFilter>('all');
  const viewModel = useMemo(() => buildMealLogWorkspaceViewModel({
    recentMeals: props.recentMeals,
    foodPlanItems: props.foodPlanItems,
    members: props.members,
    selectedMealId,
    searchQuery,
    statusFilter,
    mealFilter,
  }), [props.recentMeals, props.foodPlanItems, props.members, selectedMealId, searchQuery, statusFilter, mealFilter]);
  const activePreviewPhoto = viewModel.selectedMeal?.photos.find((photo) => photo.id === activePreviewPhotoId) ?? null;
  const mealEnrichmentFormId = 'meal-log-enrichment-overlay-form';

  useEffect(() => {
    if (!selectedMealId && viewModel.selectedMeal) {
      setSelectedMealId(viewModel.selectedMeal.id);
    }
  }, [selectedMealId, viewModel.selectedMeal?.id]);

  function openMealRecord(meal: MealLog) {
    setSelectedMealId(meal.id);
    setModalMode(getMealRecordPresentation(meal).enrichment === 'enriched' ? 'preview' : 'enrich');
  }

  const desktopTimeline = (
    <main className="meal-log-desktop-view meal-log-center-page">
      <PageHeader
        variant="compact"
        title="餐食记录中心"
        description="每一餐都是有效记录。照片、评价、家人和评论是可选补充，可以随时回来完善。"
      />

      <section className="meal-log-command-grid">
        <article className="meal-log-metric-card tone-orange">
          <span><MealLogIcon name="today" />今日已记录</span>
          <strong>{viewModel.todayMeals.length}</strong>
          <p>来自计划与手动记录</p>
        </article>
        <article className="meal-log-metric-card tone-amber">
          <span><MealLogIcon name="pending" />基础记录</span>
          <strong>{viewModel.basicMeals.length}</strong>
          <p>可补充评价、家人、照片或评论</p>
        </article>
        <article className="meal-log-metric-card tone-green">
          <span><MealLogIcon name="done" />已丰富</span>
          <strong>{viewModel.enrichedCount}</strong>
          <p>已有评价、照片或评论</p>
        </article>
        <article className="meal-log-metric-card tone-blue">
          <span><MealLogIcon name="trend" />本周记录</span>
          <strong>{viewModel.weekRecordCount}</strong>
          <p>共 {props.recentMeals.length} 条历史</p>
        </article>
      </section>

      <section className="card meal-log-record-panel">
        <div className="meal-log-filter-bar">
          <label className="meal-log-search">
            <span><MealLogIcon name="search" /></span>
            <input value={searchQuery} placeholder="搜索菜品、食材或者备注" onChange={(event) => setSearchQuery(event.target.value)} />
          </label>
          <OptionChipGroup
            ariaLabel="记录丰富度筛选"
            value={statusFilter}
            options={STATUS_FILTERS.map((item) => ({ value: item.key, label: item.label }))}
            className="meal-log-segment"
            onChange={setStatusFilter}
          />
          <div className="meal-log-meal-filter" aria-label="餐别筛选">
            {MEAL_FILTERS.map((item) => (
              <button key={item.key} type="button" className={mealFilter === item.key ? 'active' : ''} onClick={() => setMealFilter(item.key)}>
                <span className="meal-log-icon-slot"><MealLogIcon name={getMealIconName(item.key)} /></span>
                {item.label}
              </button>
            ))}
          </div>
        </div>

        <div className="meal-log-timeline-head">
          <div>
            <h2>记录时间线</h2>
            <span>按记录时间倒序展示</span>
          </div>
          <small>{viewModel.groupedMeals.reduce((total, group) => total + group.meals.length, 0)} 条记录</small>
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
                    const source = viewModel.mealSources.get(meal.id);
                    if (!source) {
                      return null;
                    }
                    const isSelected = viewModel.selectedMeal?.id === meal.id;
                    const mealStatus = getMealLogStatus(meal);
                    const mealStatusLabel = getMealLogStatusLabel(meal);
                    const presentation = getMealRecordPresentation(meal);
                    const ratingSummary = getMealRatingSummary(meal);
                    return (
                      <button
                        key={meal.id}
                        type="button"
                        className={isSelected ? 'meal-log-record-row active' : 'meal-log-record-row'}
                        onClick={() => openMealRecord(meal)}
                      >
                        <span className={`meal-log-meal-pill ${getMealTone(meal.meal_type)}`}>
                          <span className="meal-log-icon-slot"><MealLogIcon name={getMealIconName(meal.meal_type)} /></span>
                          {MEAL_TYPE_LABELS[meal.meal_type]}
                        </span>
                        <span className="meal-log-record-main">
                          <strong>{buildMealTitle(meal)}</strong>
                          <span className="meal-log-record-subline">
                            <time>{formatMealTime(meal)}</time>
                            <StatusBadge tone={source.status === 'planned' ? 'plan' : 'neutral'} size="compact" className={source.status === 'planned' ? 'badge-planned' : 'badge-manual'}>
                              {source.status === 'planned' ? '菜单计划' : '手动补录'}
                            </StatusBadge>
                          </span>
                        </span>
                        <span className="meal-log-record-info">
                          <StatusBadge
                            tone={mealStatus === 'done' ? 'success' : 'neutral'}
                            size="compact"
                            className={`meal-record-status status-${mealStatus}`}
                          >
                            {mealStatusLabel}
                          </StatusBadge>
                          <span className={ratingSummary ? 'meal-log-row-rating has-rating' : 'meal-log-row-rating'}>
                            {ratingSummary ? `★ ${ratingSummary}` : '未评分'}
                          </span>
                          <span className="meal-log-row-meta">
                            <span><span className="meal-log-icon-slot compact"><MealLogIcon name="photo" /></span>{meal.photos.length}</span>
                            <span><span className="meal-log-icon-slot compact"><MealLogIcon name="note" /></span>{meal.notes.trim() ? 1 : 0}</span>
                          </span>
                        </span>
                        <span className="meal-log-row-action">{presentation.actionLabel}</span>
                      </button>
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
            description="换一个筛选条件，或手动补录一餐。"
            className="meal-log-empty-panel"
          />
        )}
      </section>
    </main>
  );

  const mobileTimeline = (
    <MealLogMobileView
      basicMeals={viewModel.basicMeals}
      selectedMeal={viewModel.selectedMeal}
      mealSources={viewModel.mealSources}
      todayMealCount={viewModel.todayMeals.length}
      enrichedCount={viewModel.enrichedCount}
      weekRecordCount={viewModel.weekRecordCount}
      totalRecordCount={props.recentMeals.length}
      groupedMeals={viewModel.groupedMeals}
      searchQuery={searchQuery}
      statusFilter={statusFilter}
      mealFilter={mealFilter}
      onSelectMeal={setSelectedMealId}
      onOpenMealRecord={openMealRecord}
      onBackHome={props.onBackHome}
      onSearchChange={setSearchQuery}
      onStatusFilterChange={setStatusFilter}
      onMealFilterChange={setMealFilter}
      notificationCenter={props.notificationCenter}
    />
  );

  return (
    <>
      <MealHistorySurface mode="timeline" meal={viewModel.selectedMeal}>
        {mobileTimeline}
        {desktopTimeline}
      </MealHistorySurface>

      {modalMode === 'enrich' ? (
        <MealEnrichmentModal
          open
          meal={viewModel.selectedMeal}
          source={viewModel.selectedSource}
          members={props.members}
          isUpdating={props.isUpdatingMeal}
          updateMealLog={props.updateMealLog}
          onClose={() => setModalMode(null)}
          formId={mealEnrichmentFormId}
        />
      ) : null}

      {modalMode === 'preview' && (
        <WorkspaceOverlayFrame onClose={() => setModalMode(null)}>
          <WorkspaceModal
            title="这餐详情"
            description="查看这次餐食的来源、评价、评论和照片。"
            eyebrow="记录"
            className="meal-log-modal meal-log-enrich-modal meal-log-preview-modal"
            onClose={() => setModalMode(null)}
            footerActions={
              viewModel.selectedMeal && viewModel.selectedSource ? (
                <FormActions
                  className="meal-log-preview-modal-actions"
                  primaryLabel="继续补充"
                  onPrimary={() => setModalMode('enrich')}
                  secondaryLabel="取消"
                  onSecondary={() => setModalMode(null)}
                />
              ) : undefined
            }
          >
            {viewModel.selectedMeal && viewModel.selectedSource ? (
              <div className="meal-log-preview-detail">
                <div className="meal-enrichment-summary">
                  <span className={`meal-enrichment-meal-pill ${getMealTone(viewModel.selectedMeal.meal_type)}`}>
                    <span className="meal-log-icon-slot"><MealLogIcon name="done" /></span>
                    {MEAL_TYPE_LABELS[viewModel.selectedMeal.meal_type]}
                  </span>
                  <strong>{buildMealTitle(viewModel.selectedMeal)}</strong>
                  <span className="meal-enrichment-summary-divider" />
                  <small>{formatDateTime(viewModel.selectedMeal.created_at)}</small>
                  <span className="meal-enrichment-source-pill">{viewModel.selectedSource.status === 'planned' ? '来自菜单计划' : '手动补录'}</span>
                </div>

                <div className="meal-log-preview-layout">
                  <div className="meal-log-preview-main">
                    <section className="meal-log-preview-panel">
                      <div className="meal-log-preview-section-head">
                        <span>1</span>
                        <strong>菜品评分</strong>
                      </div>
                      {viewModel.selectedMeal.food_entries.some((entry) => entry.rating != null) ? (
                        <div className="meal-log-preview-ratings">
                          {viewModel.selectedMeal.food_entries.map((entry) => (
                            <div key={entry.id}>
                              <strong>{entry.food_name || '未命名菜品'}</strong>
                              <span>{entry.rating == null ? '未评分' : `★ ${entry.rating.toFixed(1).replace(/\.0$/, '')} 分`}</span>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <strong className="meal-log-preview-rating">还没有评分</strong>
                      )}
                    </section>

                    <section className="meal-log-preview-panel">
                      <div className="meal-log-preview-section-head">
                        <span>2</span>
                        <strong>参与家人</strong>
                      </div>
                      <div className="meal-log-preview-members">
                        {viewModel.selectedParticipantMembers.length > 0 ? (
                          viewModel.selectedParticipantMembers.slice(0, 8).map((member) => (
                            <span key={member.id} className="meal-log-preview-member">
                              <Avatar label={member.display_name} seed={member.avatar_seed} imageUrl={member.avatar_image?.url} />
                              {member.display_name}
                            </span>
                          ))
                        ) : (
                          <span className="meal-log-preview-member empty">未选择</span>
                        )}
                        {viewModel.selectedParticipantMembers.length > 8 && <Badge>+{viewModel.selectedParticipantMembers.length - 8}</Badge>}
                      </div>
                    </section>

                    <section className="meal-log-preview-panel">
                      <div className="meal-log-preview-section-head">
                        <span>3</span>
                        <strong>评论</strong>
                      </div>
                      <p>{viewModel.selectedMeal.notes || '这条记录还没有补充评论。'}</p>
                    </section>
                  </div>

                  <aside className="meal-log-preview-photo-side">
                    <div className="meal-log-preview-section-head">
                      <span>4</span>
                      <strong>餐食照片</strong>
                    </div>
                    <p>本次记录共 {viewModel.selectedMeal.photos.length} 张照片</p>
                    <div className="meal-log-photo-grid meal-log-preview-photo-grid">
                      {viewModel.selectedMeal.photos.slice(0, 6).map((photo) => (
                        <button key={photo.id} className="meal-photo-open-button" type="button" onClick={() => setActivePreviewPhotoId(photo.id)} aria-label="查看大图">
                          <MediaWithPlaceholder
                            src={resolveAssetUrl(photo.url) ?? photo.url}
                            alt={photo.alt || buildMealTitle(viewModel.selectedMeal!)}
                          />
                        </button>
                      ))}
                      {viewModel.selectedMeal.photos.length === 0 && <div className="meal-log-photo-placeholder">暂无照片</div>}
                      {viewModel.selectedMeal.photos.length > 6 && <div className="meal-log-photo-placeholder">+{viewModel.selectedMeal.photos.length - 6}</div>}
                    </div>
                  </aside>
                </div>

              </div>
            ) : null}
          </WorkspaceModal>
        </WorkspaceOverlayFrame>
      )}
      {activePreviewPhoto && viewModel.selectedMeal && (
        <MealPhotoLightbox photo={activePreviewPhoto} title={buildMealTitle(viewModel.selectedMeal)} onClose={() => setActivePreviewPhotoId(null)} />
      )}
    </>
  );
}
