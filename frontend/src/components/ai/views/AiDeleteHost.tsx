import type { ReactNode } from 'react';

export function AiDeleteHost(props: { open: boolean; busy?: boolean; children?: ReactNode }) {
  return props.open ? <div className="ai-delete-host" aria-busy={props.busy || undefined}>{props.children}</div> : null;
}
