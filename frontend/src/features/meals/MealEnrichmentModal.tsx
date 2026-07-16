import type { MealLog, Member, UpdateMealLogPayload } from '../../api/types';
import { FormActions, OperationLoadingOverlay, WorkspaceModal, WorkspaceOverlayFrame } from '../../components/ui-kit';
import { MealEnrichmentForm } from './MealLogEnrichment';

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
        title={props.title ?? '编辑这顿'}
        description={props.description ?? '补充评价、家人、照片和评论'}
        className="meal-log-modal meal-log-enrich-modal"
        closeAriaLabel="关闭"
        onClose={closeIfAllowed}
        busy={props.isUpdating}
        footerInfo={<span>保存后会更新这顿的评价、家人、照片和评论</span>}
        footerActions={
          <FormActions
            primaryLabel={props.primaryLabel ?? '保存'}
            primaryType="submit"
            primaryForm={formId}
            isSubmitting={props.isUpdating}
            secondaryLabel="取消"
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
          />
        </div>
      </WorkspaceModal>
    </WorkspaceOverlayFrame>
  );
}
