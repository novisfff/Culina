import type { ReactNode } from 'react';

export type StatusBadgeTone = 'neutral' | 'success' | 'warning' | 'danger' | 'info' | 'plan';

export function StatusBadge(props: { children: ReactNode; tone?: StatusBadgeTone; size?: 'default' | 'compact'; className?: string }) {
  const tone = props.tone ?? 'neutral';
  return (
    <span className={['ui-status-badge', `tone-${tone}`, props.size === 'compact' ? 'is-compact' : '', props.className].filter(Boolean).join(' ')}>
      {props.children}
    </span>
  );
}
