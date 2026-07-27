import { useId } from 'react';
import type { ReactNode } from 'react';

export function AiDraftSection(props: {
  title: string;
  description?: string;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  const titleId = useId();

  return (
    <section className={['ai-draft-section', props.className].filter(Boolean).join(' ')} role="region" aria-labelledby={titleId}>
      <header className="ai-draft-section-head">
        <div className="ai-draft-section-copy">
          <h3 id={titleId}>{props.title}</h3>
          {props.description ? <p>{props.description}</p> : null}
        </div>
        {props.action ? <div className="ai-draft-section-action">{props.action}</div> : null}
      </header>
      <div className="ai-draft-section-body">{props.children}</div>
    </section>
  );
}
