import type { ReactNode } from 'react';

export type FormFieldProps = {
  label: ReactNode;
  children: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  required?: boolean;
  disabled?: boolean;
  className?: string;
};

export function FormField({
  label,
  children,
  hint,
  error,
  required = false,
  disabled = false,
  className,
}: FormFieldProps) {
  return (
    <label className={['ui-form-field', disabled ? 'is-disabled' : '', error ? 'has-error' : '', className].filter(Boolean).join(' ')}>
      <span className="ui-form-field-label">
        {label}
        {required ? (
          <span className="ui-form-field-required" aria-label="必填">
            *
          </span>
        ) : null}
      </span>
      <span className="ui-form-field-control">{children}</span>
      {hint ? <span className="ui-form-field-hint">{hint}</span> : null}
      {error ? (
        <span className="ui-form-field-error" role="alert">
          {error}
        </span>
      ) : null}
    </label>
  );
}
