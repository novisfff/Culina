import type { ReactNode } from 'react';

export function AiHumanInputHost(props: { open: boolean; children?: ReactNode }) {
  return props.open ? <div className="ai-human-input-host">{props.children}</div> : null;
}
