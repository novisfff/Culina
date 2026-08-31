import type { ReactNode } from 'react';

export function AiDebugHost(props: { open: boolean; children?: ReactNode }) {
  return props.open ? <div className="ai-debug-host">{props.children}</div> : null;
}
