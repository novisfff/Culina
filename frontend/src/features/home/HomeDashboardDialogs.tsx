import { useEffect, useState, type Dispatch, type FormEvent, type SetStateAction } from 'react';
import type {
  Food,
  FoodPlanItem,
  Ingredient,
  MealLog,
  Member,
  Recipe,
  RecordMealTarget,
  UpdateMealLogPayload,
  VersionedInventoryItemRef,
} from '../../api/types';
import { MediaWithPlaceholder } from '../../components/MediaPlaceholder';
import { FoodPlanDetailModal, type FoodPlanDetailFormState } from '../../components/foods/FoodPlanDetailModal';
import {
  FoodPlanDateMealNoteFields,
  FoodPlanFoodPicker,
  FoodPlanSelectedHero,
} from '../../components/foods/FoodPlanDialogParts';
import {
  InventoryActionDialog,
} from '../inventory/InventoryActionDialog';
import type {
  ExpiryInventoryActionGroup,
  InventoryActionGroup,
} from '../inventory/inventoryActionModel';
import type { HomeActionCompletionSummary, HomePlanAddFormState } from './useHomeDashboardState';
import { Avatar, Badge, FormActions, OperationLoadingOverlay, WorkspaceModal, WorkspaceOverlayFrame } from '../../components/ui-kit';
import { useFoodResourceSearch } from '../../hooks/useFoodResourceSearch';
import {
  FOOD_TYPE_LABELS,
  formatDate,
  formatDateTime,
  getFoodCover,
  MEAL_TYPE_LABELS,
  todayKey,
} from '../../lib/ui';
import {
  DASHBOARD_PLAN_MEAL_TYPES,
  type DashboardPlanDay,
} from './homeDashboardModel';
import { MealCandidateSelector } from '../meals/MealCandidateSelector';
import {
  deriveCandidatePresentation,
  type MealComposerFood,
} from '../meals/MealComposerModel';
import { useMealCandidateData } from '../meals/useMealCandidateData';
import { MealEnrichmentModal } from '../meals/MealEnrichmentModal';

type Props = {
  recipes: Recipe[];
  ingredients: Ingredient[];
  homePlanDetailItem: FoodPlanItem | null;
  homePlanDetailFood: Food | null;
  homePlanDetailForm: FoodPlanDetailFormState;
  isHomePlanDetailEditing: boolean;
  setHomePlanDetailForm: (form: FoodPlanDetailFormState) => void;
  setIsHomePlanDetailEditing: (value: boolean) => void;
  resetHomePlanDetailForm: (item?: FoodPlanItem | null) => void;
  submitHomePlanDetail: (event: FormEvent<HTMLFormElement>) => Promise<void>;
  startHomePlanDetailCook: (
    item: FoodPlanItem,
    target?: {
      target_meal_log_id?: string | null;
      expected_meal_log_row_version?: number | null;
    },
  ) => Promise<void>;
  deleteHomePlanDetail: (item: FoodPlanItem) => Promise<void>;
  closeHomePlanDetail: () => void;
  isUpdatingHomePlanDetail: boolean;
  isCompletingHomePlanDetail: boolean;
  homeMealEnrichmentMeal: MealLog | null;
  homeMealEnrichmentMembers: Member[];
  closeHomeMealEnrichment: () => void;
  updateMealLog: (mealLogId: string, payload: UpdateMealLogPayload) => Promise<unknown>;
  onInvalidMealEnrichmentSave: () => void;
  isUpdatingMeal: boolean;
  isHomePlanAddDialogOpen: boolean;
  homePlanAddFood: Food | null;
  homePlanAddFoodSearch: string;
  setHomePlanAddFoodSearch: (value: string) => void;
  homePlanAddFoodOptions: Food[];
  selectHomePlanAddFood: (food: Food) => void;
  setHomePlanAddFoodId: (value: string | null) => void;
  homePlanAddForm: HomePlanAddFormState;
  setHomePlanAddForm: Dispatch<SetStateAction<HomePlanAddFormState>>;
  dashboardPlanDays: DashboardPlanDay[];
  submitHomePlanAdd: (event: FormEvent<HTMLFormElement>) => Promise<void>;
  closeHomePlanAddDialog: () => void;
  isCreatingFoodPlanItem: boolean;
  homeMealDetail: MealLog | null;
  homeMealDetailParticipants: Member[];
  closeHomeMealDetail: () => void;
  selectedActionGroup: InventoryActionGroup | null;
  businessDateKey: string;
  actionDialogBusy: boolean;
  actionDialogError: string | null;
  actionDialogConflict: 'none' | 'review_again';
  closeActionGroup: () => void;
  disposeSelectedInventoryBatches: (items: VersionedInventoryItemRef[]) => Promise<void>;
  snoozeSelectedInventoryAlerts: (args: {
    action: 'retain_expired' | 'snooze_upcoming';
    items: VersionedInventoryItemRef[];
    snoozedUntil: string;
  }) => Promise<void>;
  correctSelectedInventoryExpiryDate: (args: {
    inventoryItemId: string;
    expectedRowVersion: number;
    expiryDate: string;
  }) => Promise<void>;
  completionSummary: HomeActionCompletionSummary | null;
  nextGroupId: string | null;
  nextGroupLabel: string | null;
  openNextActionGroup: () => void;
  dismissCompletionSummary: () => void;
  onCompletionSecondaryAction: (ingredientId: string) => void;
  resolveAssetUrl: (url?: string) => string | undefined;
};

export function HomeDashboardDialogs(props: Props) {
  const today = todayKey();
  const homePlanDetailItem = props.homePlanDetailItem;
  const selectedExpiryGroup =
    props.selectedActionGroup && props.selectedActionGroup.kind === 'expiry'
      ? (props.selectedActionGroup as ExpiryInventoryActionGroup)
      : null;
  const homePlanAddFormId = 'home-plan-add-overlay-form';

  // Non-Recipe plan complete: load authoritative candidates for plan_date + meal_type.
  const needsPlanCompleteCandidates = Boolean(
    homePlanDetailItem && !homePlanDetailItem.recipe_id && homePlanDetailItem.status !== 'cooked',
  );
  const planCandidateQuery = useMealCandidateData({
    open: needsPlanCompleteCandidates,
    date: homePlanDetailItem?.plan_date ?? '',
    mealType: homePlanDetailItem?.meal_type ?? 'dinner',
  });
  const planCandidates = planCandidateQuery.candidates;
  const planCandidatesFetched = planCandidateQuery.query.isFetched;
  const planCandidateIdsKey = planCandidates
    .map((candidate) => `${candidate.meal_log_id}:${candidate.row_version}`)
    .join(',');
  const [planCompleteTarget, setPlanCompleteTarget] = useState<RecordMealTarget>({ kind: 'new' });
  const [planCompleteSelectedCandidateId, setPlanCompleteSelectedCandidateId] = useState<string | null>(
    null,
  );
  const [planCompleteCandidateMode, setPlanCompleteCandidateMode] = useState<'none' | 'single' | 'multi'>(
    'none',
  );

  useEffect(() => {
    if (!needsPlanCompleteCandidates || !homePlanDetailItem) {
      setPlanCompleteTarget((current) => (current.kind === 'new' ? current : { kind: 'new' }));
      setPlanCompleteSelectedCandidateId(null);
      setPlanCompleteCandidateMode('none');
      return;
    }
    // Wait for authoritative candidate fetch (empty list is a valid result).
    if (!planCandidatesFetched) {
      return;
    }
    const presentation = deriveCandidatePresentation(planCandidates, homePlanDetailItem.meal_type);
    setPlanCompleteTarget(presentation.target);
    setPlanCompleteSelectedCandidateId(presentation.selectedCandidateId);
    setPlanCompleteCandidateMode(presentation.mode);
    // planCandidates is captured via planCandidateIdsKey identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    needsPlanCompleteCandidates,
    homePlanDetailItem?.id,
    homePlanDetailItem?.plan_date,
    homePlanDetailItem?.meal_type,
    planCandidateIdsKey,
    planCandidatesFetched,
  ]);

  const homePlanFoodSearch = useFoodResourceSearch(props.homePlanAddFoodSearch, {
    enabled: props.isHomePlanAddDialogOpen && !props.homePlanAddFood,
    fallbackFoods: props.homePlanAddFoodOptions,
  });
  const closeHomePlanAddDialogIfAllowed = () => {
    if (!props.isCreatingFoodPlanItem) {
      props.closeHomePlanAddDialog();
    }
  };

  function handleHomePlanDetailComplete(item: FoodPlanItem) {
    if (item.recipe_id) {
      void props.startHomePlanDetailCook(item);
      return;
    }
    const target =
      planCompleteTarget.kind === 'existing'
        ? {
            target_meal_log_id: planCompleteTarget.meal_log_id,
            expected_meal_log_row_version: planCompleteTarget.expected_row_version,
          }
        : undefined;
    void props.startHomePlanDetailCook(item, target);
  }

  const planCompleteDraftFoods: MealComposerFood[] = homePlanDetailItem
    ? [
        {
          kind: 'existing',
          food_id: homePlanDetailItem.food_id,
          name: homePlanDetailItem.food_name,
          servings: 1,
          cover: null,
        },
      ]
    : [];

  const planCompleteExtras =
    homePlanDetailItem && needsPlanCompleteCandidates ? (
      <MealCandidateSelector
        mode={planCompleteCandidateMode}
        mealType={homePlanDetailItem.meal_type}
        candidates={planCandidates}
        selectedCandidateId={planCompleteSelectedCandidateId}
        target={planCompleteTarget}
        draftFoods={planCompleteDraftFoods}
        disabled={props.isCompletingHomePlanDetail}
        className="food-plan-detail-candidates"
        onTargetChange={(target, selectedCandidateId) => {
          setPlanCompleteTarget(target);
          setPlanCompleteSelectedCandidateId(selectedCandidateId ?? null);
        }}
      />
    ) : null;

  return (
    <>
      {homePlanDetailItem && (
        <FoodPlanDetailModal
          item={homePlanDetailItem}
          food={props.homePlanDetailFood}
          recipes={props.recipes}
          form={props.homePlanDetailForm}
          isEditing={props.isHomePlanDetailEditing}
          isUpdatingPlan={props.isUpdatingHomePlanDetail}
          isCompleting={props.isCompletingHomePlanDetail}
          completeExtras={planCompleteExtras}
          onClose={props.closeHomePlanDetail}
          onChangeForm={props.setHomePlanDetailForm}
          onEditingChange={props.setIsHomePlanDetailEditing}
          onResetEdit={() => props.resetHomePlanDetailForm(homePlanDetailItem)}
          onSubmit={(event) => void props.submitHomePlanDetail(event)}
          onComplete={() => handleHomePlanDetailComplete(homePlanDetailItem)}
          onDelete={() => void props.deleteHomePlanDetail(homePlanDetailItem)}
          resolveAssetUrl={(url) => props.resolveAssetUrl(url) ?? url}
          overlayRootClassName="home-dashboard-overlay-root"
        />
      )}

      {props.isHomePlanAddDialogOpen && (
        <WorkspaceOverlayFrame
          rootClassName="home-dashboard-overlay-root"
          onClose={closeHomePlanAddDialogIfAllowed}
          closeOnBackdrop={!props.isCreatingFoodPlanItem}
          busy={props.isCreatingFoodPlanItem}
        >
          <WorkspaceModal
            title="加食物到菜单"
            description="选择日期和餐次后加入当前周菜单。"
            eyebrow="菜单计划"
            onClose={closeHomePlanAddDialogIfAllowed}
            busy={props.isCreatingFoodPlanItem}
            className="recipe-plan-modal food-plan-modal home-plan-add-modal"
            footerActions={
              <FormActions
                className="recipe-plan-dialog-actions"
                primaryLabel="加入菜单"
                primaryType="submit"
                primaryForm={homePlanAddFormId}
                primaryDisabled={!props.homePlanAddFood}
                isSubmitting={props.isCreatingFoodPlanItem}
                secondaryLabel="取消"
                onSecondary={closeHomePlanAddDialogIfAllowed}
              />
            }
          >
            <form
              id={homePlanAddFormId}
              className={[
                'recipe-plan-dialog-form',
                'ui-operation-loading-host',
                props.isCreatingFoodPlanItem ? 'is-busy' : '',
              ].filter(Boolean).join(' ')}
              aria-busy={props.isCreatingFoodPlanItem}
              onSubmit={(event) => void props.submitHomePlanAdd(event)}
            >
              <OperationLoadingOverlay
                active={props.isCreatingFoodPlanItem}
                title="正在加入菜单"
              />
              {props.homePlanAddFood ? (
                <FoodPlanSelectedHero
                  food={props.homePlanAddFood}
                  coverUrl={props.resolveAssetUrl(getFoodCover(props.homePlanAddFood, props.recipes))}
                  typeLabel={FOOD_TYPE_LABELS[props.homePlanAddFood.type]}
                  sourceLabel={
                    props.homePlanAddFood.source_name ||
                    props.homePlanAddFood.purchase_source ||
                    props.homePlanAddFood.category ||
                    '常吃食物'
                  }
                  capabilityLabel={props.homePlanAddFood.recipe_id ? '有菜谱' : '可直接记录'}
                  iconKind={props.homePlanAddFood.recipe_id ? 'bookOpen' : 'clipboard'}
                  onClear={() => props.setHomePlanAddFoodId(null)}
                />
              ) : (
                <FoodPlanFoodPicker
                  searchInputId="home-food-plan-search"
                  value=""
                  query={props.homePlanAddFoodSearch}
                  loading={homePlanFoodSearch.isSearching}
                  loadingMore={homePlanFoodSearch.isFetchingNextPage}
                  hasMore={homePlanFoodSearch.hasMore}
                  options={homePlanFoodSearch.foods.map((food) => {
                    const cover = getFoodCover(food, props.recipes);
                    return {
                      id: food.id,
                      label: food.name,
                      description: [
                        FOOD_TYPE_LABELS[food.type],
                        food.source_name || food.purchase_source || food.category,
                        food.recipe_id ? '可开始做' : '可加入计划',
                      ]
                        .filter(Boolean)
                        .join(' · '),
                      image: <MediaWithPlaceholder src={props.resolveAssetUrl(cover)} alt="" />,
                    };
                  })}
                  emptyText={homePlanFoodSearch.isSearching ? '正在搜索...' : '没有找到匹配的食物'}
                  onCompositionStart={homePlanFoodSearch.onCompositionStart}
                  onCompositionEnd={homePlanFoodSearch.onCompositionEnd}
                  onQueryChange={props.setHomePlanAddFoodSearch}
                  onLoadMore={() => {
                    if (homePlanFoodSearch.hasMore && !homePlanFoodSearch.isFetchingNextPage) {
                      void homePlanFoodSearch.fetchNextPage();
                    }
                  }}
                  onChange={(foodId) => {
                    const food = homePlanFoodSearch.findFoodById(foodId);
                    if (food) props.selectHomePlanAddFood(food);
                  }}
                />
              )}

              <FoodPlanDateMealNoteFields
                planDate={props.homePlanAddForm.planDate}
                mealType={props.homePlanAddForm.mealType}
                note={props.homePlanAddForm.note}
                todayDate={today}
                planDateOptions={props.dashboardPlanDays.map((day) => ({
                  value: day.date,
                  label: day.isToday ? '今天' : `周${day.weekday}`,
                  display: day.date.slice(5).replace('-', '/'),
                }))}
                mealOptions={DASHBOARD_PLAN_MEAL_TYPES.map((value) => ({ value, label: MEAL_TYPE_LABELS[value] }))}
                notePlaceholder="比如：少油、常点套餐、提前解冻"
                onPlanDateChange={(planDate) => props.setHomePlanAddForm((current) => ({ ...current, planDate }))}
                onMealTypeChange={(mealType) => props.setHomePlanAddForm((current) => ({ ...current, mealType }))}
                onPlanNoteChange={(note) => props.setHomePlanAddForm((current) => ({ ...current, note }))}
              />
            </form>
          </WorkspaceModal>
        </WorkspaceOverlayFrame>
      )}

      <MealEnrichmentModal
        open={Boolean(props.homeMealEnrichmentMeal)}
        meal={props.homeMealEnrichmentMeal}
        members={props.homeMealEnrichmentMembers}
        isUpdating={props.isUpdatingMeal}
        updateMealLog={props.updateMealLog}
        requireMeaningfulInput={props.homeMealEnrichmentMeal?.id.startsWith('draft-')}
        onInvalidSave={props.onInvalidMealEnrichmentSave}
        onClose={props.closeHomeMealEnrichment}
        overlayRootClassName="home-dashboard-overlay-root"
        formId="home-meal-enrichment-overlay-form"
      />

      {props.homeMealDetail && (
        <WorkspaceOverlayFrame rootClassName="home-dashboard-overlay-root" onClose={props.closeHomeMealDetail}>
          <WorkspaceModal
            title="餐食详情"
            description="这条今日待办已经完成，下面是本餐记录。"
            className="dashboard-todo-modal meal-detail-modal"
            onClose={props.closeHomeMealDetail}
            footerActions={
              <FormActions
                className="dashboard-todo-actions"
                primaryLabel="知道了"
                onPrimary={props.closeHomeMealDetail}
              />
            }
          >
            <div className="dashboard-todo-dialog meal-detail-dialog">
              <section className="meal-detail-head">
                <div>
                  <Badge className="dashboard-done-badge">已完成</Badge>
                  <h3>{MEAL_TYPE_LABELS[props.homeMealDetail.meal_type]}</h3>
                  <p>{formatDate(props.homeMealDetail.date)} · {formatDateTime(props.homeMealDetail.created_at)}</p>
                </div>
                {props.homeMealDetail.mood && <strong>{props.homeMealDetail.mood}</strong>}
              </section>

              <section className="meal-detail-section">
                <span>本餐食物</span>
                <div className="meal-detail-food-list">
                  {props.homeMealDetail.food_entries.length > 0 ? (
                    props.homeMealDetail.food_entries.map((entry) => (
                      <article key={entry.id} className="meal-detail-food-item">
                        <div>
                          <strong>{entry.food_name}</strong>
                          {entry.note && <p>{entry.note}</p>}
                        </div>
                        <Badge>{entry.servings} 份</Badge>
                      </article>
                    ))
                  ) : (
                    <p className="subtle">这餐没有关联具体食物。</p>
                  )}
                </div>
              </section>

              <section className="meal-detail-section">
                <span>参与成员</span>
                <div className="meal-detail-member-row">
                  {props.homeMealDetailParticipants.length > 0 ? (
                    props.homeMealDetailParticipants.map((member) => (
                      <span key={member.id} className="meal-detail-member">
                        <Avatar label={member.display_name} seed={member.avatar_seed} imageUrl={member.avatar_image?.url} />
                        {member.display_name}
                      </span>
                    ))
                  ) : (
                    <p className="subtle">未记录参与成员。</p>
                  )}
                </div>
              </section>

              {props.homeMealDetail.notes && (
                <section className="meal-detail-section">
                  <span>备注</span>
                  <p className="meal-detail-note">{props.homeMealDetail.notes}</p>
                </section>
              )}

              {props.homeMealDetail.photos.length > 0 && (
                <section className="meal-detail-section">
                  <span>照片</span>
                  <div className="meal-detail-photo-grid">
                    {props.homeMealDetail.photos.map((photo) => (
                      <MediaWithPlaceholder
                        key={photo.id}
                        src={props.resolveAssetUrl(photo.url)}
                        alt={photo.alt || photo.name}
                      />
                    ))}
                  </div>
                </section>
              )}

            </div>
          </WorkspaceModal>
        </WorkspaceOverlayFrame>
      )}

      {selectedExpiryGroup && (
        <InventoryActionDialog
          open
          group={selectedExpiryGroup}
          referenceDate={props.businessDateKey}
          busy={props.actionDialogBusy}
          errorMessage={props.actionDialogError}
          conflictState={props.actionDialogConflict}
          overlayRootClassName="home-dashboard-overlay-root"
          onClose={props.closeActionGroup}
          onDispose={props.disposeSelectedInventoryBatches}
          onSnooze={props.snoozeSelectedInventoryAlerts}
          onCorrectExpiry={props.correctSelectedInventoryExpiryDate}
        />
      )}

      {props.completionSummary && (
        <WorkspaceOverlayFrame
          rootClassName="home-dashboard-overlay-root"
          onClose={props.dismissCompletionSummary}
        >
          <WorkspaceModal
            title={props.completionSummary.title}
            description={props.completionSummary.message}
            className="dashboard-todo-modal home-action-completion-modal"
            onClose={props.dismissCompletionSummary}
            footerActions={
              <FormActions
                className="dashboard-todo-actions"
                primaryLabel={props.nextGroupLabel ? `处理下一项：${props.nextGroupLabel}` : '知道了'}
                onPrimary={() => {
                  if (props.nextGroupId) {
                    props.openNextActionGroup();
                    return;
                  }
                  props.dismissCompletionSummary();
                }}
                secondaryLabel={
                  props.completionSummary.secondaryActionLabel
                  ?? (props.nextGroupId ? '关闭' : undefined)
                }
                onSecondary={
                  props.completionSummary.secondaryActionIngredientId
                    ? () => {
                        const ingredientId = props.completionSummary?.secondaryActionIngredientId;
                        props.dismissCompletionSummary();
                        if (ingredientId) {
                          props.onCompletionSecondaryAction(ingredientId);
                        }
                      }
                    : props.nextGroupId
                      ? props.dismissCompletionSummary
                      : undefined
                }
              />
            }
          >
            <div className="dashboard-todo-dialog">
              <p className="subtle">{props.completionSummary.message}</p>
              {props.nextGroupLabel ? (
                <p>下一项：{props.nextGroupLabel}</p>
              ) : (
                <p className="subtle">今天没有其他需要继续处理的食材。</p>
              )}
            </div>
          </WorkspaceModal>
        </WorkspaceOverlayFrame>
      )}
    </>
  );
}
