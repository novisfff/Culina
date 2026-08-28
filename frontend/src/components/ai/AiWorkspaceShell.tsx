import type { ReactNode } from 'react';

export function AiWorkspaceShell(props: {
  children: ReactNode;
  loading?: boolean;
  error?: string | null;
  notice?: ReactNode;
}) {
  return (
    <section className="ai-workspace-route-shell" aria-busy={props.loading || undefined}>
      {props.notice}
      {props.error ? <div className="ai-query-error" role="alert">{props.error}</div> : null}
      {props.children}
    </section>
  );
}
