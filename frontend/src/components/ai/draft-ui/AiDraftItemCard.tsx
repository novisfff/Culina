import type { ReactNode } from 'react';

export function AiDraftItemCard(props: {
  title: string;
  summary?: ReactNode;
  status?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  className?: string;
}) {
  return (
    <article className={['ai-draft-item-card', props.className].filter(Boolean).join(' ')}>
      <header className="ai-draft-item-card-head">
        <div className="ai-draft-item-card-copy">
          <h4>{props.title}</h4>
          {props.summary ? <p>{props.summary}</p> : null}
        </div>
        {props.status ? <div className="ai-draft-item-card-status">{props.status}</div> : null}
      </header>
      <div className="ai-draft-item-card-body">{props.children}</div>
      {props.footer ? <footer className="ai-draft-item-card-footer">{props.footer}</footer> : null}
    </article>
  );
}
