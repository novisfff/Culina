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
export function PageLoadingState(props: PageLoadingStateProps) {
  const eyebrow = props.eyebrow ?? '正在加载';
  const eyebrowLabel = props.eyebrow ? eyebrow : `${eyebrow}${props.title}`;
  const progressLabel = `${eyebrow}${props.title}`;

  return (
    <main
      className={['ui-page-loading', props.className].filter(Boolean).join(' ')}
      aria-label={props.title}
      aria-busy="true"
    >
      <section className="ui-page-loading-card" aria-labelledby="ui-page-loading-title">
        <div className="ui-page-loading-visual" aria-hidden="true">
          <span className="ui-page-loading-orbit ui-page-loading-orbit-one" />
          <span className="ui-page-loading-orbit ui-page-loading-orbit-two" />
          <span className="ui-page-loading-spark ui-page-loading-spark-one" />
          <span className="ui-page-loading-spark ui-page-loading-spark-two" />
          <span className="ui-page-loading-mark">
            <img src="/icon-192.png" alt="" draggable={false} />
          </span>
        </div>

        <div className="ui-page-loading-copy" role="status" aria-live="polite">
          <span className="ui-page-loading-eyebrow">{eyebrowLabel}</span>
          <h1 id="ui-page-loading-title">{props.title}</h1>
          <p>{props.description}</p>
        </div>

        <div className="ui-page-loading-progress" role="progressbar" aria-label={progressLabel} aria-valuetext={props.description}>
          <span />
        </div>
        <p className="ui-page-loading-hint">正在同步家庭空间</p>
      </section>
    </main>
  );
}
