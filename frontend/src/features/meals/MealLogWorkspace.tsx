import { useEffect, useMemo, useState, type FormEventHandler } from 'react';
import type { Food, FoodPlanItem, MealLog, Member, UpdateMealLogPayload } from '../../api/types';
import { Avatar, Badge, PageHeader, WorkspaceModal } from '../../components/ui-kit';
import { resolveAssetUrl } from '../../lib/assets';
import { formatDateTime, MEAL_TYPE_LABELS } from '../../lib/ui';
import { MealEnrichmentForm, MealPhotoLightbox } from './MealLogEnrichment';
import { MealLogIcon } from './MealLogIcons';
import type { LocalMealFoodEntry, MealFormState } from './MealLogComposer';
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
  getMealRatingSummary,
  getMealTone,
  isMealLogEnriched,
  resolveMealSource,
  type MealLogMealFilter,
  type MealLogStatusFilter,
} from './MealLogWorkspaceModel';

type Props = {
  form: MealFormState;
  foods: Food[];
  foodPlanItems: FoodPlanItem[];
  members: Member[];
  entries: LocalMealFoodEntry[];
  selectedParticipants: string[];
  recentMeals: MealLog[];
  isSubmitting: boolean;
  isUpdatingMeal: boolean;
  isGeneratingPhoto: boolean;
  photoErrorMessage?: string | null;
  updateMealLog: (mealLogId: string, payload: UpdateMealLogPayload) => Promise<unknown>;
  onBackHome: () => void;
  onSubmit: FormEventHandler<HTMLFormElement>;
  onFormChange: (form: MealFormState) => void;
  onToggleFood: (foodId: string, checked: boolean) => void;
  onUpdateFood: (foodId: string, key: 'servings' | 'note', value: string) => void;
  onUpdateParticipant: (userId: string, checked: boolean) => void;
  onUploadPhoto: (files: FileList | null) => void;
  onGeneratePhoto: (mode: 'reference' | 'text') => void;
  onResetPhoto: () => void;
};

type MealLogModalMode = 'enrich' | 'preview' | null;

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

export function MealLogWorkspace(props: Props) {
  const initialPendingMealId = props.recentMeals.find((meal) => !isMealLogEnriched(meal))?.id;
  const [selectedMealId, setSelectedMealId] = useState<string | null>(initialPendingMealId ?? props.recentMeals[0]?.id ?? null);
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

  useEffect(() => {
    if (!selectedMealId && viewModel.selectedMeal) {
      setSelectedMealId(viewModel.selectedMeal.id);
    }
  }, [selectedMealId, viewModel.selectedMeal?.id]);

  function openMealRecord(meal: MealLog) {
    setSelectedMealId(meal.id);
    setModalMode(isMealLogEnriched(meal) ? 'preview' : 'enrich');
  }

  return (
    <>
      <MealLogMobileView
        recentMeals={props.recentMeals}
        pendingMeals={viewModel.pendingMeals}
        selectedMeal={viewModel.selectedMeal}
        mealSources={viewModel.mealSources}
        todayMealCount={viewModel.todayMeals.length}
        enrichedCount={viewModel.enrichedCount}
        weekRecordCount={viewModel.weekRecordCount}
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
      />

      <main className="meal-log-desktop-view meal-log-center-page">
        <PageHeader
          variant="compact"
          title="餐食记录中心"
          description="记录先进入待补充状态，保存评价、家人、评论或照片后会变为已补充。"
        />

        <section className="meal-log-command-grid">
          <article className="meal-log-metric-card tone-orange">
            <span><MealLogIcon name="today" className="meal-log-ui-icon" />今日已记录</span>
            <strong>{viewModel.todayMeals.length}</strong>
            <p>来自计划与手动补录</p>
          </article>
          <article className="meal-log-metric-card tone-amber">
            <span><MealLogIcon name="pending" className="meal-log-ui-icon" />待补充</span>
            <strong>{viewModel.pendingMeals.length}</strong>
            <p>需要补充评价/家人/照片/评论</p>
          </article>
          <article className="meal-log-metric-card tone-green">
            <span><MealLogIcon name="done" className="meal-log-ui-icon" />已补充</span>
            <strong>{viewModel.enrichedCount}</strong>
            <p>已有评价、照片或评论</p>
          </article>
          <article className="meal-log-metric-card tone-blue">
            <span><MealLogIcon name="trend" className="meal-log-ui-icon" />本周记录</span>
            <strong>{viewModel.weekRecordCount}</strong>
            <p>较上周 ↑ {Math.min(viewModel.weekRecordCount, 4)}</p>
          </article>
        </section>

        <section className="card meal-log-record-panel">
            <div className="meal-log-filter-bar">
              <label className="meal-log-search">
                <span><MealLogIcon name="search" className="meal-log-ui-icon" /></span>
                <input value={searchQuery} placeholder="搜索菜品、食材或者备注" onChange={(event) => setSearchQuery(event.target.value)} />
              </label>
              <div className="meal-log-segment" aria-label="记录状态筛选">
                {STATUS_FILTERS.map((item) => (
                  <button key={item.key} type="button" className={statusFilter === item.key ? 'active' : ''} onClick={() => setStatusFilter(item.key)}>
                    {item.label}
                  </button>
                ))}
              </div>
              <div className="meal-log-meal-filter" aria-label="餐别筛选">
                {MEAL_FILTERS.map((item) => (
                  <button key={item.key} type="button" className={mealFilter === item.key ? 'active' : ''} onClick={() => setMealFilter(item.key)}>
                    <span style={iconSlotStyle}><MealLogIcon name={getMealIconName(item.key)} className="meal-log-ui-icon" /></span>
                    {item.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="meal-log-timeline-head">
              <h2>记录时间线</h2>
              <span>按记录时间倒序展示</span>
            </div>

            {viewModel.groupedMeals.length > 0 ? (
              <div className="meal-log-record-timeline">
                {viewModel.groupedMeals.map((group) => (
                  <section key={group.date} className="meal-log-day-group">
                    <div className="meal-log-day-label">
                      <span />
                      <strong>{formatDateGroupLabel(group.date)}</strong>
                    </div>
                    <div className="meal-log-record-list">
                      {group.meals.map((meal) => {
                        const source = viewModel.mealSources.get(meal.id) ?? resolveMealSource(meal, props.foodPlanItems);
                        const isSelected = viewModel.selectedMeal?.id === meal.id;
                        return (
                          <button
                            key={meal.id}
                            type="button"
                            className={isSelected ? 'meal-log-record-row active' : 'meal-log-record-row'}
                            onClick={() => openMealRecord(meal)}
                          >
                            <span className={`meal-log-meal-pill ${getMealTone(meal.meal_type)}`}>
                              <span style={iconSlotStyle}><MealLogIcon name={getMealIconName(meal.meal_type)} className="meal-log-ui-icon" /></span>
                              {MEAL_TYPE_LABELS[meal.meal_type]}
                            </span>
                            <strong>{buildMealTitle(meal)}</strong>
                            <time>{formatMealTime(meal)}</time>
                            <Badge className={source.status === 'planned' ? 'badge-planned' : 'badge-manual'}>
                              {source.status === 'planned' ? '来自菜单计划' : '手动补录'}
                            </Badge>
                            <span className={`meal-record-status status-${getMealLogStatus(meal)}`}>{getMealLogStatusLabel(meal)}</span>
                            <span className="meal-log-row-rating">{getMealRatingSummary(meal) ? `★ ${getMealRatingSummary(meal)}` : '☆ -'}</span>
                            <span className="meal-log-row-meta">
                              <span><span style={compactIconSlotStyle}><MealLogIcon name="photo" className="meal-log-ui-icon" /></span>{meal.photos.length}</span>
                              <span><span style={compactIconSlotStyle}><MealLogIcon name="note" className="meal-log-ui-icon" /></span>{meal.notes.trim() ? 1 : 0}</span>
                            </span>
                            <span className="meal-log-row-action">{isMealLogEnriched(meal) ? '查看详情' : '补充记录'}</span>
                          </button>
                        );
                      })}
                    </div>
                  </section>
                ))}
              </div>
            ) : (
              <div className="meal-log-empty-panel">没有符合条件的记录。换一个筛选条件，或手动补录一餐。</div>
            )}
        </section>
      </main>

      {modalMode && (
        <div className="workspace-overlay-root meal-log-overlay-root">
          <div className="workspace-overlay-backdrop" onClick={() => setModalMode(null)} />
          <WorkspaceModal
            title={modalMode === 'preview' ? '记录预览' : '补充记录'}
            description={
              modalMode === 'preview'
                ? '查看这次餐食的来源、评价、评论和照片。'
                : '为这次待补充记录添加评价、家人、照片和评论'
            }
            eyebrow={modalMode === 'enrich' ? undefined : '记录'}
            className="meal-log-modal meal-log-enrich-modal meal-log-preview-modal"
            onClose={() => setModalMode(null)}
          >
            {modalMode === 'preview' && viewModel.selectedMeal && viewModel.selectedSource ? (
              <div className="meal-log-preview-detail">
                <div className="meal-enrichment-summary meal-log-preview-summary">
                  <span className={`meal-enrichment-meal-pill ${getMealTone(viewModel.selectedMeal.meal_type)}`}>
                    <span style={iconSlotStyle}><MealLogIcon name="done" className="meal-log-ui-icon" /></span>
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
                          <img src={resolveAssetUrl(photo.url) ?? photo.url} alt={photo.alt || buildMealTitle(viewModel.selectedMeal)} />
                        </button>
                      ))}
                      {viewModel.selectedMeal.photos.length === 0 && <div className="meal-log-photo-placeholder">待补照片</div>}
                      {viewModel.selectedMeal.photos.length > 6 && <div className="meal-log-photo-placeholder">+{viewModel.selectedMeal.photos.length - 6}</div>}
                    </div>
                  </aside>
                </div>

                <div className="meal-log-preview-modal-actions">
                  <button className="solid-button" type="button" onClick={() => setModalMode('enrich')}>
                    继续补充
                  </button>
                </div>
              </div>
            ) : viewModel.selectedMeal && viewModel.selectedSource ? (
              <MealEnrichmentForm
                meal={viewModel.selectedMeal}
                members={props.members}
                source={viewModel.selectedSource}
                isUpdating={props.isUpdatingMeal}
                updateMealLog={props.updateMealLog}
                onCancel={() => setModalMode(null)}
                onSaved={() => setModalMode(null)}
              />
            ) : null}
          </WorkspaceModal>
        </div>
      )}
      {activePreviewPhoto && viewModel.selectedMeal && (
        <MealPhotoLightbox photo={activePreviewPhoto} title={buildMealTitle(viewModel.selectedMeal)} onClose={() => setActivePreviewPhotoId(null)} />
      )}
    </>
  );
}
