import type { AiAutoExecutionActionDefinition } from './aiAutoExecutionModel';

export function AiAutoExecutionSwitchRow(props: {
  action: AiAutoExecutionActionDefinition;
  enabled: boolean;
  effectiveEnabled: boolean;
  disabled?: boolean;
  pending?: boolean;
  requiresReconsent?: boolean;
  readOnlyMessage?: string;
  ariaLabel?: string;
  onToggle: () => void;
}) {
  const descriptionId = `ai-auto-execution-${props.action.key.replace(/\./g, '-')}-description`;
  return (
    <article className="ai-auto-execution-row">
      <div className="ai-auto-execution-row-copy">
        <strong>{props.action.label}</strong>
        <p id={descriptionId}>{props.action.description}</p>
        {props.requiresReconsent ? <span className="ai-auto-execution-row-note">需要重新确认规则</span> : null}
        {props.readOnlyMessage ? <span className="ai-auto-execution-row-note">{props.readOnlyMessage}</span> : null}
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
