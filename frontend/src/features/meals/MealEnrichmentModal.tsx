import type { MealLog, Member, UpdateMealLogPayload } from '../../api/types';
import { FormActions, OperationLoadingOverlay, WorkspaceModal, WorkspaceOverlayFrame } from '../../components/ui-kit';
import { MealEnrichmentForm, type MealSource } from './MealLogEnrichment';

export type MealEnrichmentModalProps = {
  open: boolean;
  meal: MealLog | null;
  source: MealSource | null;
  members: Member[];
  isUpdating: boolean;
  updateMealLog: (mealLogId: string, payload: UpdateMealLogPayload) => Promise<unknown>;
  onClose: () => void;
  requireMeaningfulInput?: boolean;
  onInvalidSave?: () => void;
  overlayRootClassName?: string;
  formId?: string;
};

export function MealEnrichmentModal(props: MealEnrichmentModalProps) {
  if (!props.open || !props.meal || !props.source) {
    return null;
  }

  const formId = props.formId ?? 'meal-log-enrichment-overlay-form';
  const isDraftMeal = props.meal.id.startsWith('draft-');
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
        title="补充这餐"
        description="为这次记录添加评价、家人、照片和评论"
        className="meal-log-modal meal-log-enrich-modal"
        closeAriaLabel="关闭"
        onClose={closeIfAllowed}
        busy={props.isUpdating}
        footerInfo={
          <span>
            {isDraftMeal
              ? '保存后，本次补充记录将会出现在记录时间线中'
              : '这餐已记录，保存后会补充评价、家人、照片和评论'}
          </span>
        }
        footerActions={
          <FormActions
            primaryLabel="保存记录"
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
            source={props.source}
            isUpdating={props.isUpdating}
            updateMealLog={props.updateMealLog}
            requireMeaningfulInput={props.requireMeaningfulInput}
            onInvalidSave={props.onInvalidSave}
            onSaved={props.onClose}
          />
        </div>
      </WorkspaceModal>
    </WorkspaceOverlayFrame>
  );
}
