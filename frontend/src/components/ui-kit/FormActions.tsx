import type { ReactNode } from 'react';
import { ActionButton } from './ActionButton';

export type FormActionsProps = {
  primaryLabel: ReactNode;
  children?: ReactNode;
  onPrimary?: () => void;
  primaryType?: 'button' | 'submit';
  primaryForm?: string;
  primaryTone?: 'primary' | 'danger';
  primaryPlacement?: 'before-extra' | 'after-extra';
  primaryDisabled?: boolean;
  primaryDisabledReason?: string;
  isSubmitting?: boolean;
  submittingLabel?: ReactNode;
  secondaryLabel?: ReactNode;
  secondaryIsSubmitting?: boolean;
  secondarySubmittingLabel?: ReactNode;
  onSecondary?: () => void;
  className?: string;
};

function SubmittingLabel({ children }: { children: ReactNode }) {
  return (
    <span className="ui-form-action-loading">
      <span className="ui-form-action-spinner" aria-hidden="true" />
      <span>{children}</span>
    </span>
  );
}

export function FormActions({
  primaryLabel,
  children,
  onPrimary,
  primaryType = 'button',
  primaryForm,
  primaryTone = 'primary',
  primaryPlacement = 'after-extra',
  primaryDisabled = false,
  primaryDisabledReason,
  isSubmitting = false,
  submittingLabel = '处理中...',
  secondaryLabel,
  secondaryIsSubmitting = false,
  secondarySubmittingLabel = '处理中...',
  onSecondary,
  className,
}: FormActionsProps) {
  const actionInProgress = isSubmitting || secondaryIsSubmitting;
  const disabled = primaryDisabled || actionInProgress;
  const primaryClassName = ['ui-form-actions-primary', primaryTone === 'danger' ? 'danger' : undefined]
    .filter(Boolean)
    .join(' ');
  const primaryAction = (
    <ActionButton
      tone="primary"
      type={primaryType}
      form={primaryForm}
      className={primaryClassName}
      onClick={onPrimary}
      disabled={disabled}
      aria-busy={isSubmitting || undefined}
    >
      {isSubmitting ? <SubmittingLabel>{submittingLabel}</SubmittingLabel> : primaryLabel}
    </ActionButton>
  );
  const secondaryAction = secondaryLabel ? (
    <ActionButton
      tone="secondary"
      type="button"
      className="ui-form-actions-secondary"
      onClick={onSecondary}
      disabled={actionInProgress}
      aria-busy={secondaryIsSubmitting || undefined}
    >
      {secondaryIsSubmitting
        ? <SubmittingLabel>{secondarySubmittingLabel}</SubmittingLabel>
        : secondaryLabel}
    </ActionButton>
  ) : null;

  return (
    <div className={['ui-form-actions', className].filter(Boolean).join(' ')} data-primary-placement={primaryPlacement}>
      {primaryDisabledReason && disabled ? <p className="ui-form-actions-reason">{primaryDisabledReason}</p> : null}
      <div className="ui-form-actions-row">
        <span className="ui-form-actions-spacer" />
        {primaryPlacement === 'before-extra' ? primaryAction : null}
        {secondaryAction}
        {children}
        {primaryPlacement === 'after-extra' ? primaryAction : null}
      </div>
    </div>
  );
}
