import { useEffect, useState, type Dispatch, type FormEvent, type SetStateAction } from 'react';
import type {
  Food,
  FoodPlanItem,
  Ingredient,
  MealLog,
  Member,
  Recipe,
  RecordMealPayload,
  RecordMealResponse,
  RecordMealTarget,
  RevertMealRecordResponse,
  UpdateMealLogPayload,
  VersionedInventoryItemRef,
} from '../../api/types';
import { MediaWithPlaceholder } from '../../components/MediaPlaceholder';
import { FoodPlanDetailModal, type FoodPlanDetailFormState } from '../../components/foods/FoodPlanDetailModal';
import { FoodPlanDialog } from '../../components/foods/FoodPlanDialog';
import {
  InventoryActionDialog,
} from '../inventory/InventoryActionDialog';
import type {
  ExpiryInventoryActionGroup,
  InventoryActionGroup,
} from '../inventory/inventoryActionModel';
import type { HomeActionCompletionSummary, HomePlanAddFormState } from './useHomeDashboardState';
import { Avatar, Badge, FormActions, WorkspaceModal, WorkspaceOverlayFrame } from '../../components/ui-kit';
import {
  formatDate,
  formatDateTime,
  getFoodCover,
  MEAL_TYPE_LABELS,
} from '../../lib/ui';
import type { DashboardPlanDay } from './homeDashboardModel';
import { MealCandidateSelector } from '../meals/MealCandidateSelector';
import {
  deriveCandidatePresentation,
  type MealComposerFood,
} from '../meals/MealComposerModel';
import { useMealCandidateData } from '../meals/useMealCandidateData';
import { MealEnrichmentModal } from '../meals/MealEnrichmentModal';
import { buildMealEnrichmentRecordPayload } from '../meals/MealLogEnrichmentModel';

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
    action?: 'default' | 'record',
  ) => Promise<void>;
  openHomeMealRecord: (item: FoodPlanItem) => void;
  deleteHomePlanDetail: (item: FoodPlanItem) => Promise<void>;
  closeHomePlanDetail: () => void;
  isUpdatingHomePlanDetail: boolean;
  isCompletingHomePlanDetail: boolean;
  homeMealEnrichmentMeal: MealLog | null;
  homeMealEnrichmentMembers: Member[];
  foodPlanItems: FoodPlanItem[];
  foods: Food[];
  recordMeal: (payload: RecordMealPayload) => Promise<RecordMealResponse>;
  revertMealRecord: (operationId: string) => Promise<RevertMealRecordResponse>;
  onHomeMealEnrichmentMealChanged: (meal: MealLog) => void;
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
  const homePlanDetailItem = props.homePlanDetailItem;
  const selectedExpiryGroup =
    props.selectedActionGroup && props.selectedActionGroup.kind === 'expiry'
      ? (props.selectedActionGroup as ExpiryInventoryActionGroup)
      : null;
  const pendingEnrichmentPlanItems = props.homeMealEnrichmentMeal
    ? props.foodPlanItems.filter(
        (item) =>
          item.status === 'planned' &&
          item.plan_date === props.homeMealEnrichmentMeal?.date &&
          item.meal_type === props.homeMealEnrichmentMeal?.meal_type,
      )
    : [];

  function createRecordRequestId(prefix: string) {
    return `${prefix}-${typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`}`;
  }

  function requireEnrichmentMeal() {
    if (!props.homeMealEnrichmentMeal) throw new Error('餐食记录尚未加载，请稍后重试');
    return props.homeMealEnrichmentMeal;
  }

  // Direct record (with or without a Recipe): load authoritative candidates for plan_date + meal_type.
  const needsPlanCompleteCandidates = Boolean(
    homePlanDetailItem && homePlanDetailItem.status !== 'cooked',
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

  function handleHomePlanDetailRecordEaten(item: FoodPlanItem) {
    const target =
      planCompleteTarget.kind === 'existing'
        ? {
            target_meal_log_id: planCompleteTarget.meal_log_id,
            expected_meal_log_row_version: planCompleteTarget.expected_row_version,
          }
        : undefined;
    void props.startHomePlanDetailCook(item, target, 'record');
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
          onRecordEaten={() => handleHomePlanDetailRecordEaten(homePlanDetailItem)}
          onOpenMealRecord={() => props.openHomeMealRecord(homePlanDetailItem)}
          onDelete={() => void props.deleteHomePlanDetail(homePlanDetailItem)}
          resolveAssetUrl={(url) => props.resolveAssetUrl(url) ?? url}
          overlayRootClassName="home-dashboard-overlay-root"
        />
      )}

      <FoodPlanDialog
        isOpen={props.isHomePlanAddDialogOpen}
        selectedPlanFood={props.homePlanAddFood}
        foods={props.homePlanAddFoodOptions}
        recipes={props.recipes}
        planFoodSearch={props.homePlanAddFoodSearch}
        planForm={{ ...props.homePlanAddForm, foodId: props.homePlanAddFood?.id }}
        todayDate={props.businessDateKey}
        isUpdatingPlan={props.isCreatingFoodPlanItem}
        overlayRootClassName="home-dashboard-overlay-root"
        modalClassName="home-plan-add-modal"
        onClose={props.closeHomePlanAddDialog}
        onSubmit={(event) => void props.submitHomePlanAdd(event)}
        onClearPlanFoodSelection={() => props.setHomePlanAddFoodId(null)}
        onPlanFoodSearchChange={props.setHomePlanAddFoodSearch}
        onSelectPlanFood={props.selectHomePlanAddFood}
        onPlanDateChange={(planDate) => props.setHomePlanAddForm((current) => ({ ...current, planDate }))}
        onMealTypeChange={(mealType) => props.setHomePlanAddForm((current) => ({ ...current, mealType }))}
        onPlanNoteChange={(note) => props.setHomePlanAddForm((current) => ({ ...current, note }))}
        resolveFoodAssetUrl={(url) => props.resolveAssetUrl(url) ?? url}
        getFoodCover={getFoodCover}
        getDefaultMealType={(food) => food.suitable_meal_types[0] ?? 'dinner'}
        getPlanDateParts={(dateKey) => {
          const day = props.dashboardPlanDays.find((item) => item.date === dateKey);
          const [, month = '1', date = '1'] = dateKey.split('-');
          return {
            month: Number(month),
            day: Number(date),
            weekday: day ? `周${day.weekday}` : dateKey,
          };
        }}
        normalizeFoodType={(food) => food.type}
      />

      <MealEnrichmentModal
        open={Boolean(props.homeMealEnrichmentMeal)}
        meal={props.homeMealEnrichmentMeal}
        members={props.homeMealEnrichmentMembers}
        pendingPlanItems={pendingEnrichmentPlanItems}
        availableFoods={props.foods}
        onRecordPlanItem={(item) => {
          const meal = requireEnrichmentMeal();
          return props.recordMeal(buildMealEnrichmentRecordPayload({
            meal,
            clientRequestId: createRecordRequestId(`meal-enrichment-plan-${item.id}`),
            food: { kind: 'existing', foodId: item.food_id },
            planItem: item,
          }));
        }}
        onAddExistingFood={(food) => {
          const meal = requireEnrichmentMeal();
          return props.recordMeal(buildMealEnrichmentRecordPayload({
            meal,
            clientRequestId: createRecordRequestId(`meal-enrichment-food-${food.id}`),
            food: { kind: 'existing', foodId: food.id },
          }));
        }}
        onCreateFood={(input) => {
          const meal = requireEnrichmentMeal();
          const clientFoodId = createRecordRequestId('meal-enrichment-new-food');
          return props.recordMeal(buildMealEnrichmentRecordPayload({
            meal,
            clientRequestId: createRecordRequestId('meal-enrichment-record'),
            food: { kind: 'new', clientFoodId, name: input.name, type: input.type },
          }));
        }}
        onRevertRecord={props.revertMealRecord}
        onMealChanged={props.onHomeMealEnrichmentMealChanged}
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
