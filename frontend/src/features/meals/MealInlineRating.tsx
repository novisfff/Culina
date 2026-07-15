import { useEffect, useState } from 'react';
import type { MealLog, UpdateMealLogPayload } from '../../api/types';
import { ActionButton } from '../../components/ui-kit';
import {
  buildMealEntryRatingDraft,
  buildUpdateMealLogPayload,
  parseMealRatingValue,
} from './MealLogEnrichmentModel';

export type MealInlineRatingProps = {
  meal: MealLog;
  busy?: boolean;
  error?: string | null;
  onRate: (payload: UpdateMealLogPayload) => Promise<unknown>;
};

function InlineStars(props: {
  value: string;
  disabled?: boolean;
  onChange: (value: string) => void;
}) {
  const rating = parseMealRatingValue(props.value) ?? 0;
  const fill = `${(rating / 5) * 100}%`;
  return (
    <div
      className="meal-inline-rating-stars"
      role="slider"
      aria-label="评分"
      aria-valuemin={0}
      aria-valuemax={5}
      aria-valuenow={rating}
      aria-valuetext={rating > 0 ? `${rating} 分` : '尚未填写'}
      aria-disabled={props.disabled ? true : undefined}
      tabIndex={props.disabled ? -1 : 0}
      style={{ ['--rating-width' as string]: fill }}
      onPointerDown={(event) => {
        if (props.disabled) return;
        event.preventDefault();
        const rect = event.currentTarget.getBoundingClientRect();
        const ratio = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
        const next = Math.max(0.5, Math.round(ratio * 10) / 2);
        props.onChange(String(next));
      }}
    >
      <span aria-hidden="true">★★★★★</span>
      <span className="meal-inline-rating-stars-fill" aria-hidden="true">★★★★★</span>
    </div>
  );
}

/**
 * Non-blocking per-dish rating invite for a just-recorded or selected MealLog.
 * Blank ratings create no state; no skip/debt CTA.
 */
export function MealInlineRating(props: MealInlineRatingProps) {
  const [entryRatings, setEntryRatings] = useState(() => buildMealEntryRatingDraft(props.meal));
  const [localError, setLocalError] = useState<string | null>(null);

  useEffect(() => {
    setEntryRatings(buildMealEntryRatingDraft(props.meal));
    setLocalError(null);
  }, [props.meal.id, props.meal.row_version]);

  const hasAnyRating = props.meal.food_entries.some(
    (entry) => parseMealRatingValue(entryRatings[entry.id] ?? '') != null,
  );

  async function save() {
    if (!hasAnyRating) {
      setLocalError(null);
      return;
    }
    setLocalError(null);
    try {
      const payload = buildUpdateMealLogPayload({
        meal: props.meal,
        participants: props.meal.participant_user_ids,
        notes: props.meal.notes,
        entryRatings,
      });
      await props.onRate(payload);
    } catch (reason) {
      setLocalError(reason instanceof Error ? reason.message : '评分失败，请重试');
    }
  }

  return (
    <section className="meal-inline-rating" aria-label="为这顿打分">
      <div className="meal-inline-rating-head">
        <strong>这顿怎么样？</strong>
        <small>可以现在打分，也可以直接离开</small>
      </div>
      <div className="meal-inline-rating-list">
        {props.meal.food_entries.map((entry) => (
          <div key={entry.id} className="meal-inline-rating-row">
            <strong>{entry.food_name || '未命名菜品'}</strong>
            <InlineStars
              value={entryRatings[entry.id] ?? ''}
              disabled={props.busy}
              onChange={(value) =>
                setEntryRatings((current) => ({ ...current, [entry.id]: value }))
              }
            />
          </div>
        ))}
      </div>
      <div className="meal-inline-rating-actions">
        <ActionButton
          tone="primary"
          size="compact"
          type="button"
          disabled={props.busy || !hasAnyRating}
          onClick={() => {
            void save();
          }}
        >
          保存评分
        </ActionButton>
      </div>
      {props.error || localError ? (
        <p className="meal-inline-rating-error">{props.error || localError}</p>
      ) : null}
    </section>
  );
}
