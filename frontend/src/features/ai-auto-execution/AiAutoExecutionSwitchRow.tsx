import type { AiAutoExecutionActionDefinition } from './aiAutoExecutionModel';
import { StatusBadge } from '../../components/ui-kit';

export function AiAutoExecutionSwitchRow(props: {
  action: AiAutoExecutionActionDefinition;
  enabled: boolean;
  effectiveEnabled: boolean;
  disabled?: boolean;
  pending?: boolean;
  requiresReconsent?: boolean;
  readOnlyMessage?: string;
  ariaLabel?: string;
  errorMessage?: string;
  onRetry?: () => void;
  onToggle: () => void;
}) {
  const descriptionId = `ai-auto-execution-${props.action.key.replace(/\./g, '-')}-description`;
  return (
    <article className="ai-auto-execution-row">
      <div className="ai-auto-execution-row-copy">
        <strong>{props.action.label}</strong>
        <p id={descriptionId}>{props.action.description}</p>
        {props.requiresReconsent ? <StatusBadge tone="warning" size="compact">需要重新确认规则</StatusBadge> : null}
        {props.readOnlyMessage ? <span className="ai-auto-execution-row-note">{props.readOnlyMessage}</span> : null}
        {props.errorMessage ? <p className="ai-auto-execution-row-error" role="alert">{props.errorMessage} {props.onRetry ? <button type="button" onClick={props.onRetry}>重试</button> : null}</p> : null}
      </div>
      <button
        type="button"
        className="ai-auto-execution-switch"
        role="switch"
        aria-label={props.ariaLabel ?? props.action.label}
        aria-checked={props.enabled}
        aria-describedby={descriptionId}
        aria-busy={props.pending || undefined}
        disabled={props.disabled || props.pending}
        onClick={props.onToggle}
      >
        <span aria-hidden="true" className="ai-auto-execution-switch-thumb" />
        <span className="sr-only">{props.effectiveEnabled ? '已开启' : '未开启'}</span>
      </button>
    </article>
  );
}
