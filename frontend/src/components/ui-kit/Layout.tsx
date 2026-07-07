import type { ReactNode } from 'react';

export function SectionHeading(props: { title: string; description: string; actions?: ReactNode }) {
  return (
    <div className="section-heading">
      <div>
        <h2>{props.title}</h2>
        <p className="subtle">{props.description}</p>
      </div>
      {props.actions}
    </div>
  );
}

export function PageHeader(props: {
  eyebrow?: string;
  title: string;
  description: string;
  actions?: ReactNode;
  meta?: ReactNode;
  variant?: 'compact' | 'workspace';
}) {
  return (
    <section
      className={
        props.variant === 'workspace'
          ? 'page-header page-header-workspace card'
          : 'page-header page-header-compact card'
      }
    >
      <div className="page-header-copy">
        {props.eyebrow && <p className="eyebrow">{props.eyebrow}</p>}
        <h2>{props.title}</h2>
        <p className="subtle">{props.description}</p>
      </div>
      {(props.meta || props.actions) && (
        <div className="page-header-side">
          {props.meta}
          {props.actions}
        </div>
      )}
    </section>
  );
}

export function WorkspaceSubnav<T extends string>(props: {
  items: Array<{ value: T; label: string; icon?: ReactNode }>;
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <div className="workspace-subnav" role="tablist" aria-label="工作区子导航">
      {props.items.map((item) => (
        <button
          key={item.value}
          className={props.value === item.value ? 'workspace-subnav-item active' : 'workspace-subnav-item'}
          type="button"
          onClick={() => props.onChange(item.value)}
        >
          {item.icon && <span className="workspace-subnav-item-icon">{item.icon}</span>}
          {item.label}
        </button>
      ))}
    </div>
  );
}

export function WorkspaceSubpageHeader(props: {
  eyebrow: string;
  title: string;
  description: string;
  backLabel: string;
  onBack: () => void;
  meta?: ReactNode;
  actions?: ReactNode;
  variant?: 'default' | 'compact';
}) {
  return (
    <section
      className={
        props.variant === 'compact'
          ? 'workspace-subpage-header workspace-subpage-header-compact'
          : 'workspace-subpage-header'
      }
    >
      <div className="workspace-subpage-breadcrumb">
        <button className="workspace-back-link" type="button" onClick={props.onBack}>
          {props.backLabel}
        </button>
        {props.meta}
      </div>
      <div className="workspace-subpage-body">
        <div className="workspace-subpage-copy">
          <p className="eyebrow">{props.eyebrow}</p>
          <h2>{props.title}</h2>
          <p className="subtle">{props.description}</p>
        </div>
        {props.actions && <div className="workspace-subpage-actions">{props.actions}</div>}
      </div>
    </section>
  );
}

export function WorkspaceSubpageShell(props: { children: ReactNode; className?: string }) {
  return (
    <section className={props.className ? `workspace-subpage workspace-subpage-shell card ${props.className}` : 'workspace-subpage workspace-subpage-shell card'}>
      {props.children}
    </section>
  );
}
