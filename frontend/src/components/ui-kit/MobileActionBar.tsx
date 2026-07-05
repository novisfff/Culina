import type { ReactNode } from 'react';

export function MobileActionBar(props: { children: ReactNode; className?: string }) {
  return <div className={['ui-mobile-action-bar', props.className].filter(Boolean).join(' ')}>{props.children}</div>;
}
