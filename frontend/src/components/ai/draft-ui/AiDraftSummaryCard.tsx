import { useId } from 'react';
import type { ReactNode } from 'react';
import { StatusBadge } from '../../ui-kit';
import type { AiDraftSummaryItem, AiDraftTone } from './types';

const summaryToneLabels: Record<AiDraftTone, string> = {
  plan: '待确认草稿',
  warning: '需要留意',
  danger: '请确认影响',
  neutral: '草稿信息',
  success: '已确认',
};

export function AiDraftSummaryCard(props: {
  title: string;
  items: readonly AiDraftSummaryItem[];
  tone?: AiDraftTone;
  children?: ReactNode;
  className?: string;
}) {
  const titleId = useId();
  const tone = props.tone ?? 'plan';

  return (
    <section className={['ai-draft-summary-card', `tone-${tone}`, props.className].filter(Boolean).join(' ')} role="region" aria-labelledby={titleId}>
      <header className="ai-draft-summary-card-head">
        <h3 id={titleId}>{props.title}</h3>
        <StatusBadge tone={tone} size="compact">{summaryToneLabels[tone]}</StatusBadge>
      </header>
      {props.items.length > 0 ? (
        <dl className="ai-draft-summary-items">
          {props.items.map((item) => (
            <div key={item.label} className="ai-draft-summary-item">
              <dt>{item.label}</dt>
              <dd>{item.value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      {props.children ? <div className="ai-draft-summary-extra">{props.children}</div> : null}
    </section>
  );
}
