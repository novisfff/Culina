import type { ReactNode } from 'react';
import { WorkspaceModal } from '../ui-kit';
import { FormActions } from './FormActions';

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

  return (
    <div className={['workspace-overlay-root ui-confirm-dialog-root', rootClassName].filter(Boolean).join(' ')}>
      <div
        className="workspace-overlay-backdrop"
        onClick={() => {
          if (!isSubmitting) onCancel();
        }}
      />
      <WorkspaceModal
        title={title}
        description={typeof description === 'string' ? description : undefined}
        closeLabel={cancelLabel}
        closeAriaLabel={typeof cancelLabel === 'string' ? cancelLabel : '关闭确认弹窗'}
        className={['ui-confirm-dialog', tone === 'danger' ? 'is-danger' : '', modalClassName].filter(Boolean).join(' ')}
        onClose={() => {
          if (!isSubmitting) onCancel();
        }}
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
    </div>
  );
}
