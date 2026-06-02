import type { FormEvent } from 'react';
import type { MealLog, MediaAsset, Member, UpdateMealLogPayload } from '../../api/types';
import { Avatar } from '../../components/ui-kit';
import { FoodRatingInput } from '../../components/foods/FoodWorkspacePrimitives';
import { resolveAssetUrl } from '../../lib/assets';
import { formatDate, MEAL_TYPE_LABELS } from '../../lib/ui';
import { buildMealTitle, type MealSource } from './MealLogEnrichmentModel';
import { useMealEnrichmentState } from './useMealEnrichmentState';
export { buildMealTitle, getMealRatingSummary, isMealLogEnriched, resolveMealSource, type MealSource } from './MealLogEnrichmentModel';

type MealEnrichmentIconName =
  | 'calendar'
  | 'check'
  | 'close'
  | 'image'
  | 'info';

function MealEnrichmentIcon({ name }: { name: MealEnrichmentIconName }) {
  const paths: Record<MealEnrichmentIconName, JSX.Element> = {
    calendar: (
      <>
        <path d="M7 4v3" />
        <path d="M17 4v3" />
        <path d="M5.5 8.5h13" />
        <rect x="5" y="6" width="14" height="15" rx="3" />
        <path d="M8.5 12h.1" />
        <path d="M12 12h.1" />
        <path d="M15.5 12h.1" />
        <path d="M8.5 16h.1" />
        <path d="M12 16h.1" />
      </>
    ),
    check: <path d="M6 12.5l3.2 3.2L18 7.8" />,
    close: (
      <>
        <path d="M7.5 7.5l9 9" />
        <path d="M16.5 7.5l-9 9" />
      </>
    ),
    image: (
      <>
        <rect x="4.5" y="5" width="15" height="14" rx="3" />
        <circle cx="9" cy="9.5" r="1.6" />
        <path d="M6.5 16l4-4 3 3 1.7-1.7L18 16" />
      </>
    ),
    info: (
      <>
        <circle cx="12" cy="12" r="8" />
        <path d="M12 10.5v5" />
        <path d="M12 7.5h.1" />
      </>
    ),
  };

  return (
    <svg className="meal-enrichment-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      {paths[name]}
    </svg>
  );
}

export function MealPhotoLightbox(props: { photo: MediaAsset; title: string; onClose: () => void }) {
  const photoUrl = resolveAssetUrl(props.photo.url) ?? props.photo.url;
  const downloadName = props.photo.name || `${props.title || '餐食照片'}.jpg`;

  return (
    <div className="meal-photo-lightbox" role="dialog" aria-modal="true" aria-label="查看餐食照片">
      <button className="meal-photo-lightbox-backdrop" type="button" aria-label="关闭大图" onClick={props.onClose} />
      <div className="meal-photo-lightbox-panel">
        <div className="meal-photo-lightbox-head">
          <div>
            <strong>{props.photo.alt || props.title || '餐食照片'}</strong>
            <span>{props.photo.name}</span>
          </div>
          <div className="meal-photo-lightbox-actions">
            <a className="ghost-button" href={photoUrl} download={downloadName} target="_blank" rel="noreferrer">
              下载原图
            </a>
            <button className="solid-button" type="button" onClick={props.onClose}>
              关闭
            </button>
          </div>
        </div>
        <img src={photoUrl} alt={props.photo.alt || props.title} />
      </div>
    </div>
  );
}

export function MealEnrichmentForm(props: {
  meal: MealLog;
  members: Member[];
  source: MealSource;
  isUpdating: boolean;
  updateMealLog: (mealLogId: string, payload: UpdateMealLogPayload) => Promise<unknown>;
  requireMeaningfulInput?: boolean;
  onInvalidSave?: () => void;
  onCancel?: () => void;
  onSaved?: () => void;
}) {
  const enrichmentState = useMealEnrichmentState({
    meal: props.meal,
    isUpdating: props.isUpdating,
    updateMealLog: props.updateMealLog,
    requireMeaningfulInput: props.requireMeaningfulInput,
    onInvalidSave: props.onInvalidSave,
    onSaved: props.onSaved,
  });

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await enrichmentState.save(true);
  }

  const title = buildMealTitle(props.meal);

  return (
    <form className="meal-enrichment-form" onSubmit={submit}>
      <div className="meal-enrichment-summary">
        <span className="meal-enrichment-meal-pill">
          <span><MealEnrichmentIcon name="check" /></span>
          {MEAL_TYPE_LABELS[props.meal.meal_type]}
        </span>
        <strong>{title}</strong>
        <span className="meal-enrichment-summary-divider" />
        <small><MealEnrichmentIcon name="calendar" />{formatDate(props.meal.date)} {props.meal.created_at.slice(11, 16)}</small>
        <span className="meal-enrichment-source-pill">{props.source.status === 'planned' ? '来自菜单计划' : '手动补录'}</span>
      </div>

      <div className="meal-enrichment-layout">
        <div className="meal-enrichment-main">
          <section className="meal-enrichment-step">
            <div className="meal-enrichment-step-title">
              <span>1</span>
              <strong>{props.meal.food_entries.length > 1 ? '每道菜打分' : '这道菜打几分'}</strong>
            </div>
            <div className="meal-dish-rating-list" aria-label="菜品评分">
              {props.meal.food_entries.map((entry) => (
                <div key={entry.id} className="meal-dish-rating-row">
                  <div className="meal-dish-rating-copy">
                    <strong>{entry.food_name || '未命名菜品'}</strong>
                    <small>{entry.servings} 份{entry.note ? ` · ${entry.note}` : ''}</small>
                  </div>
                  <FoodRatingInput value={enrichmentState.entryRatings[entry.id] ?? ''} onChange={(value) => enrichmentState.updateEntryRating(entry.id, value)} />
                </div>
              ))}
            </div>
          </section>

          <section className="meal-enrichment-step">
            <div className="meal-enrichment-step-title">
              <span>2</span>
              <strong>参与家人</strong>
            </div>
            <div className="meal-enrichment-member-pills">
              {props.members.map((member) => {
                const selected = enrichmentState.participants.includes(member.id);
                return (
                  <button key={member.id} type="button" className={selected ? 'active' : ''} onClick={() => enrichmentState.toggleParticipant(member.id, !selected)}>
                    <Avatar label={member.display_name} seed={member.avatar_seed} imageUrl={member.avatar_image?.url} />
                    {member.display_name}
                    <i>{selected && <MealEnrichmentIcon name="check" />}</i>
                  </button>
                );
              })}
            </div>
          </section>

          <section className="meal-enrichment-step">
            <div className="meal-enrichment-step-title">
              <span>3</span>
              <strong>评论</strong>
            </div>
            <label className="meal-enrichment-notes">
              <textarea
                className="text-input"
                rows={4}
                maxLength={300}
                value={enrichmentState.notes}
                placeholder="口味、分量、家人反馈、下次想怎么调整..."
                onChange={(event) => enrichmentState.setNotes(event.target.value)}
              />
              <small>{enrichmentState.notes.length}/300</small>
            </label>
          </section>

        </div>

        <aside className="meal-enrichment-photo-side">
          <div className="meal-enrichment-step-title">
            <span>4</span>
            <strong>餐食照片</strong>
          </div>
          <p>可上传本次真实餐食照片，帮助回顾与分享</p>
          <div className="meal-enrichment-photo-grid">
            {enrichmentState.photos.map((photo) => (
              <div className="meal-enrichment-photo-thumb" key={photo.id}>
                <button className="meal-photo-open-button" type="button" onClick={() => enrichmentState.setActivePhoto(photo)} aria-label="查看大图">
                  <img src={resolveAssetUrl(photo.url) ?? photo.url} alt={photo.alt || title} />
                </button>
                <button className="meal-photo-remove-button" type="button" onClick={() => enrichmentState.removePhoto(photo.id)} aria-label="移除照片">
                  <MealEnrichmentIcon name="close" />
                </button>
              </div>
            ))}
            <label className={enrichmentState.hasPhotoCapacity ? 'meal-enrichment-photo-add' : 'meal-enrichment-photo-add disabled'}>
              <input
                type="file"
                accept="image/*"
                multiple
                disabled={!enrichmentState.hasPhotoCapacity || enrichmentState.isBusy}
                onChange={(event) => {
                  void enrichmentState.uploadPhotos(event.target.files);
                  event.currentTarget.value = '';
                }}
              />
              <span className="meal-photo-add-icon"><MealEnrichmentIcon name="image" /></span>
              <strong>添加照片</strong>
              <small>{enrichmentState.photoState.isGenerating ? '上传中...' : enrichmentState.hasPhotoCapacity ? '最多6张' : '已满6张'}</small>
            </label>
          </div>
          {enrichmentState.photoState.errorMessage && <p className="meal-enrichment-photo-error">{enrichmentState.photoState.errorMessage}</p>}
        </aside>
      </div>

      <div className="meal-enrichment-footer">
        <span><i><MealEnrichmentIcon name="info" /></i>保存后，本次补充记录将会出现在记录时间线中</span>
        <div>
          <button className="ghost-button" type="button" onClick={props.onCancel}>
            稍后再说
          </button>
          <button className="solid-button" type="submit" disabled={enrichmentState.isBusy}>
            {props.isUpdating ? '保存中...' : enrichmentState.photoState.isGenerating ? '上传中...' : '保存记录'}
          </button>
        </div>
      </div>
      {enrichmentState.activePhoto && <MealPhotoLightbox photo={enrichmentState.activePhoto} title={title} onClose={() => enrichmentState.setActivePhoto(null)} />}
    </form>
  );
}
