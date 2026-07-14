export type OperationLoadingOverlayProps = {
  active: boolean;
  title: string;
  description?: string;
  className?: string;
};

export function OperationLoadingOverlay(props: OperationLoadingOverlayProps) {
  if (!props.active) {
    return null;
  }

  return (
    <div
      className={['ui-operation-loading-overlay', props.className].filter(Boolean).join(' ')}
      role="status"
      aria-live="polite"
      aria-busy="true"
    >
      <span className="ui-operation-loading-spinner" aria-hidden="true" />
      <strong>{props.title}</strong>
      <p>{props.description ?? '请稍候，完成前请不要重复操作。'}</p>
    </div>
  );
}
