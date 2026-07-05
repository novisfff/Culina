import type { ReactNode } from 'react';
import { ActionButton } from '../ui-kit';

export type FormActionsProps = {
  primaryLabel: ReactNode;
  children?: ReactNode;
  onPrimary?: () => void;
  primaryType?: 'button' | 'submit';
  primaryTone?: 'primary' | 'danger';
  primaryDisabled?: boolean;
  primaryDisabledReason?: string;
  isSubmitting?: boolean;
  secondaryLabel?: ReactNode;
  onSecondary?: () => void;
  className?: string;
};

export function FormActions({
  primaryLabel,
  children,
  onPrimary,
  primaryType = 'button',
  primaryTone = 'primary',
  primaryDisabled = false,
  primaryDisabledReason,
  isSubmitting = false,
  secondaryLabel,
  onSecondary,
  className,
}: FormActionsProps) {
  const disabled = primaryDisabled || isSubmitting;
  return (
    <div className={['ui-form-actions', className].filter(Boolean).join(' ')}>
      {primaryDisabledReason && disabled ? <p className="ui-form-actions-reason">{primaryDisabledReason}</p> : null}
      <div className="ui-form-actions-row">
        <span className="ui-form-actions-spacer" />
        {secondaryLabel ? (
          <ActionButton tone="secondary" type="button" onClick={onSecondary} disabled={isSubmitting}>
            {secondaryLabel}
          </ActionButton>
        ) : null}
        {children}
        <ActionButton
          tone="primary"
          type={primaryType}
          className={primaryTone === 'danger' ? 'danger' : undefined}
          onClick={onPrimary}
          disabled={disabled}
        >
          {isSubmitting ? '处理中...' : primaryLabel}
        </ActionButton>
      </div>
    </div>
  );
}
