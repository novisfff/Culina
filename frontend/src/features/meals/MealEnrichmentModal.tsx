import type { Food, FoodPlanItem, MealLog, Member, RecordMealResponse, RevertMealRecordResponse, UpdateMealLogPayload } from '../../api/types';
import { FormActions, OperationLoadingOverlay, WorkspaceModal, WorkspaceOverlayFrame } from '../../components/ui-kit';
import { MealEnrichmentForm } from './MealLogEnrichment';
import type { MealComposerFoodType } from './MealComposerModel';

export type MealEnrichmentModalProps = {
  open: boolean;
  meal: MealLog | null;
  members: Member[];
  isUpdating: boolean;
  updateMealLog: (mealLogId: string, payload: UpdateMealLogPayload) => Promise<unknown>;
  onClose: () => void;
  requireMeaningfulInput?: boolean;
  onInvalidSave?: () => void;
  overlayRootClassName?: string;
  formId?: string;
  title?: string;
  description?: string;
  primaryLabel?: string;
  pendingPlanItems?: FoodPlanItem[];
  availableFoods?: Food[];
  onRecordPlanItem?: (item: FoodPlanItem) => Promise<RecordMealResponse>;
  onAddExistingFood?: (food: Food) => Promise<RecordMealResponse>;
  onCreateFood?: (input: { name: string; type: MealComposerFoodType }) => Promise<RecordMealResponse>;
  onRevertRecord?: (operationId: string) => Promise<RevertMealRecordResponse>;
  onMealChanged?: (meal: MealLog) => void;
};

export function MealEnrichmentModal(props: MealEnrichmentModalProps) {
  if (!props.open || !props.meal) {
    return null;
  }

  const formId = props.formId ?? 'meal-log-enrichment-overlay-form';
  const closeIfAllowed = () => {
    if (!props.isUpdating) {
      props.onClose();
    }
  };

  return (
    <WorkspaceOverlayFrame
      rootClassName={props.overlayRootClassName}
      closeOnBackdrop={!props.isUpdating}
      busy={props.isUpdating}
      onClose={closeIfAllowed}
    >
      <WorkspaceModal
        title={props.title ?? `评价这顿${props.meal.meal_type === 'breakfast' ? '早餐' : props.meal.meal_type === 'lunch' ? '午餐' : props.meal.meal_type === 'dinner' ? '晚餐' : '加餐'}`}
        description={props.description ?? '评价属于整餐，星级记录每个食物的家庭共享感受'}
        className="meal-log-modal meal-log-enrich-modal"
        closeAriaLabel="关闭"
        onClose={closeIfAllowed}
        busy={props.isUpdating}
        footerInfo={<span>餐食已经记录；关闭评价不会撤销这顿</span>}
        footerActions={
          <FormActions
            primaryLabel={props.primaryLabel ?? '保存'}
            primaryType="submit"
            primaryForm={formId}
            isSubmitting={props.isUpdating}
            secondaryLabel="稍后再说"
            onSecondary={closeIfAllowed}
          />
        }
      >
        <div
          className={['ui-operation-loading-host', props.isUpdating ? 'is-busy' : ''].filter(Boolean).join(' ')}
          aria-busy={props.isUpdating}
        >
          <OperationLoadingOverlay active={props.isUpdating} title="正在保存餐食记录" />
          <MealEnrichmentForm
            formId={formId}
            meal={props.meal}
            members={props.members}
            isUpdating={props.isUpdating}
            updateMealLog={props.updateMealLog}
            requireMeaningfulInput={props.requireMeaningfulInput}
            onInvalidSave={props.onInvalidSave}
            onSaved={props.onClose}
            pendingPlanItems={props.pendingPlanItems}
            availableFoods={props.availableFoods}
            onRecordPlanItem={props.onRecordPlanItem}
            onAddExistingFood={props.onAddExistingFood}
            onCreateFood={props.onCreateFood}
            onRevertRecord={props.onRevertRecord}
            onMealChanged={props.onMealChanged}
          />
        </div>
      </WorkspaceModal>
    </WorkspaceOverlayFrame>
  );
}
