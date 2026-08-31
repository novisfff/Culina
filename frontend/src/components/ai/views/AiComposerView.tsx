import type { ReactNode } from 'react';

export function AiComposerView(props: { children: ReactNode; disabled?: boolean }) {
  return <div className="ai-composer-view" aria-disabled={props.disabled || undefined}>{props.children}</div>;
}
