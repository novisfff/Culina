import type { ReactNode } from 'react';

export function AiQualityHost(props: { open: boolean; children?: ReactNode }) {
  return props.open ? <div className="ai-quality-host">{props.children}</div> : null;
}
