import type { ReactNode } from 'react';

export function AiApprovalHost(props: { open: boolean; busy?: boolean; children?: ReactNode }) {
  if (!props.open) return null;
  return <div className="ai-approval-host" aria-busy={props.busy || undefined}>{props.children}</div>;
}
