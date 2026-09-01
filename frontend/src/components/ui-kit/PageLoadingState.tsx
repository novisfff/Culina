export type PageLoadingStateProps = {
  title: string;
  description: string;
  eyebrow?: string;
  className?: string;
};

/**
 * Shared full-page loading surface for route-level and workspace-level data.
 * It intentionally owns presentation only; callers provide the concrete copy.
 */
export function PageLoadingState({ title, description, eyebrow = '正在加载', className }: PageLoadingStateProps) {
  const eyebrowLabel = eyebrow === '正在加载' ? `${eyebrow}${title}` : eyebrow;

  return (
    <main
      className={['login-shell', className].filter(Boolean).join(' ')}
      aria-label={title}
      aria-busy="true"
    >
      <section className="login-card" role="status">
        <p className="eyebrow">{eyebrowLabel}</p>
        <h1>{title}</h1>
        <p className="subtle">{description}</p>
        <span className="ui-operation-loading-spinner" role="progressbar" aria-label={`${eyebrow}${title}`} />
      </section>
    </main>
  );
}
