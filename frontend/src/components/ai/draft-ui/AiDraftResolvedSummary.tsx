import { useId } from 'react';
import type { ReactNode } from 'react';
import { StatusBadge } from '../../ui-kit';
import type { AiDraftResolvedStatus, AiDraftTone } from './types';

const resolvedStatusMeta: Record<AiDraftResolvedStatus, { label: string; tone: AiDraftTone }> = {
  approved: { label: '已确认', tone: 'success' },
  rejected: { label: '已拒绝', tone: 'neutral' },
  expired: { label: '已失效', tone: 'danger' },
  cancelled: { label: '已取消', tone: 'neutral' },
  canceled: { label: '已取消', tone: 'neutral' },
};

export function AiDraftResolvedSummary(props: {
  status: AiDraftResolvedStatus;
  title: string;
  summary: ReactNode;
  children?: ReactNode;
  className?: string;
}) {
  const titleId = useId();
  const meta = resolvedStatusMeta[props.status];

  return (
    <section className={['ai-draft-resolved-summary', `tone-${meta.tone}`, props.className].filter(Boolean).join(' ')} role="status" aria-live="polite" aria-labelledby={titleId}>
      <header className="ai-draft-resolved-summary-head">
        <div>
          <h3 id={titleId}>{props.title}</h3>
          <p>{props.summary}</p>
        </div>
        <StatusBadge tone={meta.tone} size="compact">{meta.label}</StatusBadge>
      </header>
      {props.children ? <div className="ai-draft-resolved-summary-body">{props.children}</div> : null}
    </section>
  );
}
