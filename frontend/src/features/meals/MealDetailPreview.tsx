import type { Food, MealLog, Member } from '../../api/types';
import { MediaWithPlaceholder } from '../../components/MediaPlaceholder';
import { Avatar, Badge } from '../../components/ui-kit';
import { buildMediaSizes, buildMediaSrcSet, resolveMediaUrl } from '../../lib/assets';
import { FOOD_TYPE_LABELS, MEAL_TYPE_LABELS, formatDateTime } from '../../lib/ui';
import { MealCover } from './MealCover';
import { MealLogIcon } from './MealLogIcons';
import { buildMealTitle, getMealIconName, getMealTone } from './MealLogWorkspaceModel';

export type MealDetailPreviewProps = {
  meal: MealLog;
  foods: Food[];
  participantMembers: Member[];
  members: Member[];
  onOpenPhoto: (photoId: string) => void;
};

function formatRating(rating: number | null | undefined): string {
  return rating == null ? '未评分' : `★ ${rating.toFixed(1).replace(/\.0$/, '')} 分`;
}

export function MealDetailPreview(props: MealDetailPreviewProps) {
  const foodsById = new Map(props.foods.map((food) => [food.id, food]));
  const membersById = new Map(props.members.map((member) => [member.id, member]));
  const title = buildMealTitle(props.meal);
  const recorder = props.meal.created_by ? membersById.get(props.meal.created_by) : null;
  const coverFoods = props.meal.food_entries.map((entry) => {
    const food = foodsById.get(entry.food_id);
    return {
      id: entry.id,
      name: entry.food_name || food?.name || '未命名食物',
      cover: food?.images[0] ?? null,
    };
  });

  return (
    <div className="meal-log-preview-detail">
      <section className="meal-log-preview-summary" aria-label="餐食摘要">
        <span className="meal-log-preview-cover">
          <MealCover
            alt={`餐食封面：${title}`}
            mealPhoto={props.meal.photos[0] ?? null}
            foods={coverFoods}
          />
        </span>
        <div className="meal-log-preview-summary-copy">
          <span className={`meal-log-preview-meal-pill ${getMealTone(props.meal.meal_type)}`}>
            <span className="meal-log-icon-slot compact">
              <MealLogIcon name={getMealIconName(props.meal.meal_type)} />
            </span>
            {MEAL_TYPE_LABELS[props.meal.meal_type]}
          </span>
          <strong>{title}</strong>
          <small>
            <time>{formatDateTime(props.meal.created_at)}</time>
            {recorder ? <span>{recorder.display_name}记录</span> : null}
          </small>
        </div>
      </section>

      <section className="meal-log-preview-foods" aria-labelledby="meal-log-preview-foods-title">
        <div className="meal-log-preview-section-title">
          <strong id="meal-log-preview-foods-title">这顿吃了什么</strong>
          <span>{props.meal.food_entries.length} 道食物</span>
        </div>
        <div className="meal-log-preview-food-list">
          {props.meal.food_entries.map((entry) => {
            const food = foodsById.get(entry.food_id);
            const cover = food?.images[0] ?? null;
            const name = entry.food_name || food?.name || '未命名食物';
            return (
              <div key={entry.id} className="meal-log-preview-food-row">
                <span className="meal-log-preview-food-media">
                  <MediaWithPlaceholder
                    src={resolveMediaUrl(cover, 'thumb')}
                    srcSet={buildMediaSrcSet(cover)}
                    sizes={buildMediaSizes('thumb')}
                    alt={name}
                    showLabel={false}
                  />
                </span>
                <span className="meal-log-preview-food-copy">
                  <strong>{name}</strong>
                  <small>{food ? FOOD_TYPE_LABELS[food.type] : '已有食物'}</small>
                </span>
                <span className={`meal-log-preview-food-rating${entry.rating == null ? ' is-empty' : ''}`}>
                  {formatRating(entry.rating)}
                </span>
              </div>
            );
          })}
        </div>
      </section>

      <div className="meal-log-preview-support-grid">
        <div className="meal-log-preview-support-column">
          <section className="meal-log-preview-support-panel">
            <div className="meal-log-preview-section-title">
              <strong>参与家人</strong>
              {props.participantMembers.length > 0 ? <span>{props.participantMembers.length} 人</span> : null}
            </div>
            {props.participantMembers.length > 0 ? (
              <div className="meal-log-preview-members">
                {props.participantMembers.slice(0, 8).map((member) => (
                  <span key={member.id} className="meal-log-preview-member">
                    <Avatar
                      label={member.display_name}
                      seed={member.avatar_seed}
                      imageUrl={member.avatar_image?.url}
                    />
                    {member.display_name}
                  </span>
                ))}
                {props.participantMembers.length > 8 ? (
                  <Badge>+{props.participantMembers.length - 8}</Badge>
                ) : null}
              </div>
            ) : (
              <p className="meal-log-preview-empty">没有选择参与家人</p>
            )}
          </section>

          <section className="meal-log-preview-support-panel">
            <div className="meal-log-preview-section-title">
              <strong>评论</strong>
            </div>
            <p className={props.meal.notes ? 'meal-log-preview-comment' : 'meal-log-preview-empty'}>
              {props.meal.notes || '还没有评论'}
            </p>
          </section>
        </div>

        <section className="meal-log-preview-support-panel meal-log-preview-photo-panel">
          <div className="meal-log-preview-section-title">
            <strong>餐食照片</strong>
            {props.meal.photos.length > 0 ? <span>{props.meal.photos.length} 张</span> : null}
          </div>
          {props.meal.photos.length > 0 ? (
            <div className="meal-log-photo-grid meal-log-preview-photo-grid">
              {props.meal.photos.slice(0, 6).map((photo) => (
                <button
                  key={photo.id}
                  className="meal-photo-open-button"
                  type="button"
                  onClick={() => props.onOpenPhoto(photo.id)}
                  aria-label={`查看餐食照片：${photo.alt || title}`}
                >
                  <MediaWithPlaceholder
                    src={resolveMediaUrl(photo, 'card')}
                    srcSet={buildMediaSrcSet(photo)}
                    sizes={buildMediaSizes('card')}
                    alt={photo.alt || title}
                  />
                </button>
              ))}
              {props.meal.photos.length > 6 ? (
                <div className="meal-log-photo-placeholder">+{props.meal.photos.length - 6}</div>
              ) : null}
            </div>
          ) : (
            <div className="meal-log-preview-photo-empty">
              <span className="meal-log-icon-slot" aria-hidden="true">
                <MealLogIcon name="photo" />
              </span>
              <span>暂无餐食照片</span>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
