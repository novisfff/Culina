import type { MealInsight } from '../../api/types';
import { MediaWithPlaceholder } from '../../components/MediaPlaceholder';
import { buildMediaSizes, buildMediaSrcSet, resolveMediaUrl } from '../../lib/assets';
import { buildMealInsightPresentation } from './MealLogWorkspaceModel';

export type MealMemoryStripStatus = 'idle' | 'loading' | 'success' | 'error';

export type MealMemoryStripProps = {
  insights: MealInsight[];
  status: MealMemoryStripStatus;
  onRetry: () => void;
  className?: string;
};

/**
 * Photo-first family memory strip for the history timeline.
 * Empty success → null; error → local retry; loading → skeleton.
 * Never blocks the host timeline.
 */
export function MealMemoryStrip(props: MealMemoryStripProps) {
  const { insights, status, onRetry } = props;
  const rootClass = ['meal-memory-strip', props.className].filter(Boolean).join(' ');

  if (status === 'loading') {
    return (
      <section className={rootClass} aria-label="家庭记忆加载中" data-memory-status="loading">
        <div className="meal-memory-strip-row" aria-hidden="true">
          {[0, 1, 2].map((index) => (
            <div key={index} className="meal-memory-card meal-memory-card-skeleton">
              <span className="meal-memory-card-media" />
              <span className="meal-memory-card-copy">
                <span className="meal-memory-skeleton-line" />
                <span className="meal-memory-skeleton-line is-short" />
              </span>
            </div>
          ))}
        </div>
      </section>
    );
  }

  if (status === 'error') {
    return (
      <section className={rootClass} aria-label="家庭记忆" data-memory-status="error">
        <div className="meal-memory-error">
          <span>家庭记忆暂时加载失败</span>
          <button
            type="button"
            className="meal-memory-retry"
            onClick={() => onRetry()}
          >
            重试
          </button>
        </div>
      </section>
    );
  }

  if (status !== 'success' || insights.length === 0) {
    return null;
  }

  return (
    <section className={rootClass} aria-label="家庭记忆" data-memory-status="success">
      <div className="meal-memory-strip-row">
        {insights.map((item) => {
          const presentation = buildMealInsightPresentation(item);
          const cover = item.food.cover ?? null;
          const coverUrl = resolveMediaUrl(cover, 'card') ?? resolveMediaUrl(cover, 'thumb');
          return (
            <article
              key={`${item.kind}-${item.food.id}`}
              className="meal-memory-card"
              data-food-id={item.food.id}
              data-insight-kind={item.kind}
            >
              <span className="meal-memory-card-media">
                <MediaWithPlaceholder
                  src={coverUrl}
                  srcSet={buildMediaSrcSet(cover)}
                  sizes={buildMediaSizes('card')}
                  alt={cover?.alt || item.food.name}
                  showLabel={false}
                  emptyLabel="暂无封面"
                />
              </span>
              <span className="meal-memory-card-copy">
                <strong className="meal-memory-card-title">{presentation.title}</strong>
                <span className="meal-memory-card-name">{item.food.name}</span>
                <small className="meal-memory-card-evidence">{presentation.evidence}</small>
              </span>
            </article>
          );
        })}
      </div>
    </section>
  );
}
