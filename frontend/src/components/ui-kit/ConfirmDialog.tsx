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
  closeLabel?: ReactNode;
  tone?: 'primary' | 'danger';
  isSubmitting?: boolean;
  rootClassName?: string;
  modalClassName?: string;
  actionsClassName?: string;
  onConfirm: () => void;
  onCancel: () => void;
  onClose?: () => void;
};

export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel,
  cancelLabel = '取消',
  closeLabel,
  tone = 'primary',
  isSubmitting = false,
  rootClassName,
  modalClassName,
  actionsClassName,
  onConfirm,
  onCancel,
  onClose,
}: ConfirmDialogProps) {
  if (!open) return null;

  const resolvedCloseLabel = closeLabel ?? cancelLabel;

  function closeIfAllowed() {
    if (!isSubmitting) (onClose ?? onCancel)();
  }

  return (
    <WorkspaceOverlayFrame
      rootClassName={rootClassName}
      closeOnBackdrop={!isSubmitting}
      onClose={closeIfAllowed}
    >
      <WorkspaceModal
        title={title}
        description={typeof description === 'string' ? description : undefined}
        closeLabel={resolvedCloseLabel}
        closeAriaLabel={typeof resolvedCloseLabel === 'string' ? resolvedCloseLabel : '关闭确认弹窗'}
        className={modalClassName}
        onClose={closeIfAllowed}
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
