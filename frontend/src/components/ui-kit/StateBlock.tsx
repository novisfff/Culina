export type StateBlockProps = {
  status: 'empty' | 'loading' | 'error';
  title: string;
  description: string;
  actionLabel?: string;
  onAction?: () => void;
  className?: string;
};

export function StateBlock(props: StateBlockProps) {
  return (
    <div
      className={['ui-state-block', `is-${props.status}`, props.className].filter(Boolean).join(' ')}
      role={props.status === 'error' ? 'alert' : 'status'}
      aria-busy={props.status === 'loading' || undefined}
    >
      <strong>{props.title}</strong>
      <p>{props.description}</p>
      {props.actionLabel && props.onAction ? (
        <button className="ui-state-block-action" type="button" onClick={props.onAction}>
          {props.actionLabel}
        </button>
      ) : null}
    </div>
  );
}
