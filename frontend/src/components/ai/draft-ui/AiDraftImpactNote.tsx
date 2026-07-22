import type { ReactNode } from 'react';
import { StatusBadge } from '../../ui-kit';
import type { AiDraftTone } from './types';

type AiDraftImpactTone = Exclude<AiDraftTone, 'success'>;

const impactToneLabels: Record<AiDraftImpactTone, string> = {
  plan: '确认前说明',
  warning: '需要留意',
  danger: '请确认影响',
  neutral: '说明',
};

export function AiDraftImpactNote(props: {
  tone: AiDraftImpactTone;
  title: string;
  children: ReactNode;
  className?: string;
}) {
  const role = props.tone === 'danger' ? 'alert' : 'note';

  return (
    <div className={['ai-draft-impact-note', `tone-${props.tone}`, props.className].filter(Boolean).join(' ')} role={role} aria-label={props.title}>
      <div className="ai-draft-impact-note-head">
        <StatusBadge tone={props.tone} size="compact">{impactToneLabels[props.tone]}</StatusBadge>
        <h4>{props.title}</h4>
      </div>
      <div className="ai-draft-impact-note-body">{props.children}</div>
    </div>
  );
}
