import type { ReactNode } from 'react';
import { FormActions } from './FormActions';
import { WorkspaceModal } from './WorkspaceOverlay';
import { WorkspaceOverlayFrame } from './WorkspaceOverlayFrame';

export type ConfirmDialogProps = {
  open: boolean;
  title: string;
  description: ReactNode;
  confirmLabel: ReactNode;
  cancelLabel?: ReactNode;
  tone?: 'primary' | 'danger';
  isSubmitting?: boolean;
  rootClassName?: string;
  modalClassName?: string;
  actionsClassName?: string;
  onConfirm: () => void;
  onCancel: () => void;
};

export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel,
  cancelLabel = '取消',
  tone = 'primary',
  isSubmitting = false,
  rootClassName,
  modalClassName,
  actionsClassName,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  if (!open) return null;

  function cancelIfAllowed() {
    if (!isSubmitting) onCancel();
  }

  return (
    <WorkspaceOverlayFrame
      rootClassName={rootClassName}
      closeOnBackdrop={!isSubmitting}
      onClose={cancelIfAllowed}
    >
      <WorkspaceModal
        title={title}
        description={typeof description === 'string' ? description : undefined}
        closeLabel={cancelLabel}
        closeAriaLabel={typeof cancelLabel === 'string' ? cancelLabel : '关闭确认弹窗'}
        className={modalClassName}
        onClose={cancelIfAllowed}
        footerActions={
          <FormActions
            primaryLabel={confirmLabel}
            primaryTone={tone === 'danger' ? 'danger' : 'primary'}
            secondaryLabel={cancelLabel}
            isSubmitting={isSubmitting}
            className={actionsClassName}
            onPrimary={onConfirm}
            onSecondary={onCancel}
          />
        }
      >
        {typeof description === 'string' ? null : <div className="ui-confirm-dialog-description">{description}</div>}
      </WorkspaceModal>
    </WorkspaceOverlayFrame>
  );
}
