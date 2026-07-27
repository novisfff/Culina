import { useId } from 'react';
import type { ReactNode } from 'react';

export function AiDraftField(props: {
  label: string;
  helpText?: string;
  error?: string;
  required?: boolean;
  children: ReactNode;
  className?: string;
}) {
  const labelId = useId();
  const helpTextId = useId();
  const errorId = useId();
  const descriptionIds = [props.helpText ? helpTextId : '', props.error ? errorId : ''].filter(Boolean).join(' ') || undefined;

  return (
    <div
      className={['ai-draft-field', props.className].filter(Boolean).join(' ')}
      role="group"
      aria-labelledby={labelId}
      aria-describedby={descriptionIds}
    >
      <span id={labelId} className="ai-draft-field-label">
        {props.label}
        {props.required ? <span className="ai-draft-field-required">必填</span> : null}
      </span>
      {props.helpText ? <p id={helpTextId} className="ai-draft-field-help">{props.helpText}</p> : null}
      <div className="ai-draft-field-control">{props.children}</div>
      {props.error ? <p id={errorId} className="ai-draft-field-error" role="alert">{props.error}</p> : null}
    </div>
  );
}
