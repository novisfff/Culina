import { useState, useRef, useEffect, type FormEvent } from 'react';
import { createPortal } from 'react-dom';
import type { Food, FoodPlanItem, MealLog, MediaAsset, Member, RecordMealResponse, RevertMealRecordResponse, UpdateMealLogPayload } from '../../api/types';
import { Avatar, StarRatingInput } from '../../components/ui-kit';
import { useOverlayFocusLifecycle } from '../../components/ui-kit/useOverlayFocusLifecycle';
import { MediaWithPlaceholder } from '../../components/MediaPlaceholder';
import { buildMediaSizes, buildMediaSrcSet, resolveAssetUrl, resolveMediaUrl } from '../../lib/assets';
import { formatDate, MEAL_TYPE_LABELS } from '../../lib/ui';
import { buildMealTitle, type MealSource } from './MealLogEnrichmentModel';
import { formatMealTime } from './MealLogWorkspaceModel';
import { useMealEnrichmentState } from './useMealEnrichmentState';
import { MealFoodCombobox } from './MealFoodCombobox';
import type { MealComposerFood, MealComposerFoodType } from './MealComposerModel';
export { buildMealTitle, getMealRatingSummary, isMealLogEnriched, resolveMealSource, type MealSource } from './MealLogEnrichmentModel';

type MealEnrichmentIconName =
  | 'calendar'
  | 'check'
  | 'close'
  | 'image';

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
  };

  return (
    <svg className="meal-enrichment-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      {paths[name]}
    </svg>
  );
}

function MealDishThumbnail(props: { food?: Food; name: string }) {
  const cover = props.food?.images[0] ?? null;
  return (
    <div className="meal-dish-rating-media">
      <MediaWithPlaceholder
        src={resolveMediaUrl(cover, 'thumb')}
        srcSet={buildMediaSrcSet(cover)}
        sizes={buildMediaSizes('thumb')}
        alt={cover?.alt || props.name}
        loading="lazy"
        decoding="async"
        showLabel={false}
      />
    </div>
  );
}

export function MealPhotoLightbox(props: { photo: MediaAsset; title: string; onClose: () => void }) {
  const photoUrl = resolveAssetUrl(props.photo.url) ?? props.photo.url;
  const downloadName = props.photo.name || `${props.title || '餐食照片'}.jpg`;

  const [scale, setScale] = useState(1);
  const [translateX, setTranslateX] = useState(0);
  const [translateY, setTranslateY] = useState(0);
  const [rotation, setRotation] = useState(0);
  const [isDragging, setIsDragging] = useState(false);
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 });

  const viewportRef = useRef<HTMLDivElement>(null);
  const lightboxRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  useOverlayFocusLifecycle({
    rootRef: lightboxRef,
    onClose: props.onClose,
    initialFocusRef: closeButtonRef,
  });

  const zoomIn = () => setScale(prev => Math.min(prev + 0.25, 4));
  const zoomOut = () => {
    setScale(prev => {
      const next = Math.max(prev - 0.25, 1);
      if (next === 1) {
        setTranslateX(0);
        setTranslateY(0);
      }
      return next;
    });
  };
  const rotateClockwise = () => setRotation(prev => (prev + 90) % 360);
  const reset = () => {
    setScale(1);
    setTranslateX(0);
    setTranslateY(0);
    setRotation(0);
  };

  const handleMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    if (scale <= 1) return;
    setIsDragging(true);
    setDragStart({ x: e.clientX - translateX, y: e.clientY - translateY });
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (!isDragging) return;
    setTranslateX(e.clientX - dragStart.x);
    setTranslateY(e.clientY - dragStart.y);
  };

  const handleMouseUpOrLeave = () => {
    setIsDragging(false);
  };

  const handleDoubleClick = () => {
    if (scale > 1) {
      reset();
    } else {
      setScale(2);
    }
  };

  const handleTouchStart = (e: React.TouchEvent) => {
    if (e.touches.length === 1) {
      if (scale <= 1) return;
      setIsDragging(true);
      const touch = e.touches[0];
      setDragStart({ x: touch.clientX - translateX, y: touch.clientY - translateY });
    }
  };

  const handleTouchMove = (e: React.TouchEvent) => {
    if (!isDragging || e.touches.length !== 1) return;
    const touch = e.touches[0];
    setTranslateX(touch.clientX - dragStart.x);
    setTranslateY(touch.clientY - dragStart.y);
  };

  const handleTouchEnd = () => {
    setIsDragging(false);
  };

  const handleViewportClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) {
      props.onClose();
    }
  };

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;

    const handleWheel = (e: WheelEvent) => {
      e.preventDefault();
      const delta = e.deltaY < 0 ? 0.15 : -0.15;
      setScale(prev => {
        const next = Math.min(Math.max(prev + delta, 1), 4);
        if (next === 1) {
          setTranslateX(0);
          setTranslateY(0);
        }
        return next;
      });
    };

    viewport.addEventListener('wheel', handleWheel, { passive: false });
    return () => {
      viewport.removeEventListener('wheel', handleWheel);
    };
  }, []);

  return createPortal(
    <div ref={lightboxRef} className="meal-photo-lightbox" role="dialog" aria-modal="true" aria-label="查看餐食照片" tabIndex={-1}>
      <button className="meal-photo-lightbox-backdrop" type="button" tabIndex={-1} aria-label="关闭大图" onClick={props.onClose} />
      
      <div className="meal-photo-lightbox-head">
        <div className="meal-photo-lightbox-info">
          <strong>{props.photo.alt || props.title || '餐食照片'}</strong>
          {props.photo.name && <span>{props.photo.name}</span>}
        </div>
        <div className="meal-photo-lightbox-actions">
          <a className="meal-photo-lightbox-download" href={photoUrl} download={downloadName} target="_blank" rel="noreferrer">
            下载原图
          </a>
          <button ref={closeButtonRef} className="meal-photo-lightbox-close" type="button" onClick={props.onClose}>
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M18 6L6 18M6 6l12 12"/></svg>
            <span>关闭</span>
          </button>
        </div>
      </div>

      <div 
        className={`meal-photo-lightbox-viewport ${isDragging ? 'grabbing' : ''}`}
        ref={viewportRef}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUpOrLeave}
        onMouseLeave={handleMouseUpOrLeave}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
        onDoubleClick={handleDoubleClick}
        onClick={handleViewportClick}
      >
        <img 
          src={photoUrl} 
          alt={props.photo.alt || props.title} 
          draggable={false}
          style={{
            transform: `translate(${translateX}px, ${translateY}px) scale(${scale}) rotate(${rotation}deg)`,
          }}
          onClick={e => e.stopPropagation()}
        />

        <div className="meal-photo-lightbox-toolbar" onMouseDown={e => e.stopPropagation()} onClick={e => e.stopPropagation()}>
          <button type="button" onClick={zoomOut} disabled={scale <= 1} title="缩小">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M5 12h14"/></svg>
          </button>
          <span className="meal-photo-lightbox-scale-text">{Math.round(scale * 100)}%</span>
          <button type="button" onClick={zoomIn} disabled={scale >= 4} title="放大">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M12 5v14M5 12h14"/></svg>
          </button>
          <span className="meal-photo-lightbox-divider" />
          <button type="button" onClick={rotateClockwise} title="顺时针旋转90°">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M21.5 2v6h-6M21.34 8a10 10 0 10-.5 6"/></svg>
          </button>
          <button type="button" onClick={reset} disabled={scale === 1 && rotation === 0 && translateX === 0 && translateY === 0} title="重置">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M3 12a9 9 0 109-9 9.75 9.75 0 00-6.74 2.74L3 8M3 3v5h5"/></svg>
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}

export function MealEnrichmentForm(props: {
  formId?: string;
  meal: MealLog;
  members: Member[];
  isUpdating: boolean;
  updateMealLog: (mealLogId: string, payload: UpdateMealLogPayload) => Promise<unknown>;
  requireMeaningfulInput?: boolean;
  onInvalidSave?: () => void;
  onSaved?: () => void;
  pendingPlanItems?: FoodPlanItem[];
  availableFoods?: Food[];
  onRecordPlanItem?: (item: FoodPlanItem) => Promise<RecordMealResponse>;
  onAddExistingFood?: (food: Food) => Promise<RecordMealResponse>;
  onCreateFood?: (input: { name: string; type: MealComposerFoodType }) => Promise<RecordMealResponse>;
  onRevertRecord?: (operationId: string) => Promise<RevertMealRecordResponse>;
  onMealChanged?: (meal: MealLog) => void;
}) {
  const enrichmentState = useMealEnrichmentState({
    meal: props.meal,
    isUpdating: props.isUpdating,
    updateMealLog: props.updateMealLog,
    requireMeaningfulInput: props.requireMeaningfulInput,
    onInvalidSave: props.onInvalidSave,
    onSaved: props.onSaved,
  });
  const [foodQuery, setFoodQuery] = useState('');
  const [showFoodAdder, setShowFoodAdder] = useState(false);
  const [recordingKey, setRecordingKey] = useState<string | null>(null);
  const [foodActionError, setFoodActionError] = useState<string | null>(null);
  const [locallyCompletedPlanIds, setLocallyCompletedPlanIds] = useState<Set<string>>(() => new Set());
  const [recentOperations, setRecentOperations] = useState<Record<string, string>>({});
  const [recentPlanItems, setRecentPlanItems] = useState<Record<string, string>>({});

  useEffect(() => {
    setFoodQuery('');
    setShowFoodAdder(false);
    setRecordingKey(null);
    setFoodActionError(null);
    setLocallyCompletedPlanIds(new Set());
    setRecentOperations({});
    setRecentPlanItems({});
  }, [props.meal.id]);

  const pendingPlanItems = (props.pendingPlanItems ?? []).filter(
    (item) => item.status === 'planned' && !locallyCompletedPlanIds.has(item.id),
  );
  const foodsById = new Map((props.availableFoods ?? []).map((food) => [food.id, food]));
  const selectedFoods: MealComposerFood[] = props.meal.food_entries.map((entry) => ({
    kind: 'existing',
    food_id: entry.food_id,
    name: entry.food_name,
    servings: entry.servings,
  }));
  const availableFoods = (props.availableFoods ?? []).filter((food) =>
    food.name.toLocaleLowerCase('zh-CN').includes(foodQuery.trim().toLocaleLowerCase('zh-CN')),
  );

  async function applyRecordAction(key: string, action: () => Promise<RecordMealResponse>, planItemId?: string) {
    setRecordingKey(key);
    setFoodActionError(null);
    try {
      const response = await action();
      if (planItemId) {
        setLocallyCompletedPlanIds((current) => new Set([...current, planItemId]));
      }
      const entryIds = response.operation.created_entry_ids ?? [];
      if (response.operation.can_revert && entryIds.length > 0) {
        setRecentOperations((current) => ({
          ...current,
          ...Object.fromEntries(entryIds.map((entryId) => [entryId, response.operation.id])),
        }));
        if (planItemId) {
          setRecentPlanItems((current) => ({
            ...current,
            ...Object.fromEntries(entryIds.map((entryId) => [entryId, planItemId])),
          }));
        }
      }
      props.onMealChanged?.(response.meal_log);
      setFoodQuery('');
      setShowFoodAdder(false);
    } catch (reason) {
      setFoodActionError(reason instanceof Error ? reason.message : '记录失败，请重试');
    } finally {
      setRecordingKey(null);
    }
  }

  async function revertEntry(entryId: string, operationId: string) {
    if (!props.onRevertRecord) return;
    setRecordingKey(`revert:${entryId}`);
    setFoodActionError(null);
    try {
      const response = await props.onRevertRecord(operationId);
      setRecentOperations((current) => {
        const next = { ...current };
        delete next[entryId];
        return next;
      });
      const planItemId = recentPlanItems[entryId];
      if (planItemId) {
        setLocallyCompletedPlanIds((current) => {
          const next = new Set(current);
          next.delete(planItemId);
          return next;
        });
        setRecentPlanItems((current) => {
          const next = { ...current };
          delete next[entryId];
          return next;
        });
      }
      if (response.meal_log) props.onMealChanged?.(response.meal_log);
    } catch (reason) {
      setFoodActionError(reason instanceof Error ? reason.message : '撤回失败，请重试');
    } finally {
      setRecordingKey(null);
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await enrichmentState.save(true);
  }

  const title = buildMealTitle(props.meal);

  return (
    <form id={props.formId} className="meal-enrichment-form" onSubmit={submit}>
      <div className="meal-enrichment-summary">
        <span className="meal-enrichment-meal-pill">
          <span><MealEnrichmentIcon name="check" /></span>
          {MEAL_TYPE_LABELS[props.meal.meal_type]}
        </span>
        <strong>{title}</strong>
        <span className="meal-enrichment-summary-divider" />
        <small><MealEnrichmentIcon name="calendar" />{formatDate(props.meal.date)} {formatMealTime(props.meal)}</small>
      </div>
      {enrichmentState.staleMessage ? (
        <p className="meal-enrichment-stale-message">{enrichmentState.staleMessage}</p>
      ) : null}

      <div className="meal-enrichment-layout">
        <div className="meal-enrichment-main">
          <section className="meal-enrichment-step meal-enrichment-foods-step">
            <div className="meal-enrichment-step-title">
              <span>1</span>
              <strong>这顿吃了什么</strong>
              <small>单品评分为家庭共享</small>
            </div>
            <div className="meal-dish-rating-list" aria-label="菜品评分">
              {props.meal.food_entries.map((entry) => (
                <div key={entry.id} className="meal-dish-rating-row">
                  <div className="meal-dish-rating-identity">
                    <MealDishThumbnail food={foodsById.get(entry.food_id)} name={entry.food_name || '未命名菜品'} />
                    <div className="meal-dish-rating-copy">
                      <strong>{entry.food_name || '未命名菜品'}</strong>
                      <small>{entry.servings} 份 · 已记录{entry.note ? ` · ${entry.note}` : ''}</small>
                      {recentOperations[entry.id] && props.onRevertRecord ? (
                        <button
                          type="button"
                          className="meal-enrichment-entry-undo"
                          disabled={recordingKey === `revert:${entry.id}`}
                          onClick={() => void revertEntry(entry.id, recentOperations[entry.id])}
                        >
                          {recordingKey === `revert:${entry.id}` ? '正在撤回…' : '撤回刚才添加'}
                        </button>
                      ) : null}
                    </div>
                  </div>
                  <StarRatingInput value={enrichmentState.entryRatings[entry.id] ?? ''} onChange={(value) => enrichmentState.updateEntryRating(entry.id, value)} />
                </div>
              ))}
              {pendingPlanItems.map((item) => (
                <div key={item.id} className="meal-dish-rating-row is-pending-plan">
                  <div className="meal-dish-rating-identity">
                    <MealDishThumbnail food={foodsById.get(item.food_id)} name={item.food_name || '未命名食物'} />
                    <div className="meal-dish-rating-copy">
                      <strong>{item.food_name || '未命名食物'}</strong>
                      <small>本餐计划 · 尚未记录</small>
                    </div>
                  </div>
                  <button
                    type="button"
                    className="meal-enrichment-record-plan"
                    aria-label={`记录${item.food_name || '这个食物'}已吃`}
                    disabled={Boolean(recordingKey || !props.onRecordPlanItem)}
                    onClick={() => props.onRecordPlanItem && void applyRecordAction(`plan:${item.id}`, () => props.onRecordPlanItem!(item), item.id)}
                  >
                    {recordingKey === `plan:${item.id}` ? '…' : '＋'}
                  </button>
                </div>
              ))}
            </div>
            {props.onAddExistingFood || props.onCreateFood ? (
              <div className="meal-enrichment-food-adder">
                {showFoodAdder ? (
                  <MealFoodCombobox
                    query={foodQuery}
                    results={availableFoods}
                    selectedFoods={selectedFoods}
                    disabled={Boolean(recordingKey)}
                    onQueryChange={setFoodQuery}
                    onSelectExisting={(food) => props.onAddExistingFood && void applyRecordAction(`food:${food.id}`, () => props.onAddExistingFood!(food))}
                    onCreateNew={(input) => props.onCreateFood && void applyRecordAction(`new:${input.name}`, () => props.onCreateFood!(input))}
                  />
                ) : (
                  <button type="button" className="meal-enrichment-add-food" onClick={() => setShowFoodAdder(true)}>
                    ＋ 添加其他实际吃的食物
                  </button>
                )}
              </div>
            ) : (
              <span className="meal-enrichment-add-food is-disabled">＋ 添加其他实际吃的食物</span>
            )}
            {foodActionError ? <p className="meal-enrichment-food-action-error" role="alert">{foodActionError}</p> : null}
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
          <div className="meal-log-photo-grid meal-enrichment-photo-grid">
            {enrichmentState.photos.map((photo) => (
              <div className="meal-enrichment-photo-thumb" key={photo.id}>
                <button className="meal-photo-open-button" type="button" onClick={() => enrichmentState.setActivePhoto(photo)} aria-label="查看大图">
                  <MediaWithPlaceholder src={resolveAssetUrl(photo.url) ?? photo.url} alt={photo.alt || title} />
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

      {enrichmentState.activePhoto && <MealPhotoLightbox photo={enrichmentState.activePhoto} title={title} onClose={() => enrichmentState.setActivePhoto(null)} />}
    </form>
  );
}
