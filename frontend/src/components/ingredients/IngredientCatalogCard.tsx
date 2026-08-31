import { useRef } from 'react';
import type { IngredientSummaryViewModel } from './workspaceModel';
import { buildCatalogCardStatus, getIngredientAlertTone, countDisposableExpiredInventoryItems } from './workspaceModel';
import { buildMediaSizes, buildMediaSrcSet, resolveMediaUrl } from '../../lib/assets';
import { businessDateKey } from '../../lib/date';
import { MediaWithPlaceholder } from '../MediaPlaceholder';
import { ActionButton } from '../ui-kit';
import { tracksIngredientQuantity } from '../../lib/ingredientTracking';
import { IngredientQuickDetailPopover } from './IngredientQuickDetailPopover';

type IngredientCatalogCardProps = {
  summary: IngredientSummaryViewModel;
  expanded: boolean;
  onToggle: () => void;
  onRestock: () => void;
  onConsume: () => void;
  onAddShopping: () => void;
  onHandleAlert: () => void;
  onDetail: () => void;
};

export function IngredientCatalogCard(props: IngredientCatalogCardProps) {
  const { summary, expanded } = props;
  const cardRef = useRef<HTMLElement | null>(null);
  const hasCustomImage = Boolean(summary.ingredient.image?.url);
  const imageUrl = resolveMediaUrl(summary.ingredient.image, 'card');
  const alertTone = getIngredientAlertTone(summary);
  const status = buildCatalogCardStatus(summary);
  const tracksQuantity = tracksIngredientQuantity(summary.ingredient);
  const canConsume = tracksQuantity && summary.availableInventoryItems.length > 0;
  const canDestroyExpired = countDisposableExpiredInventoryItems(summary, businessDateKey()) > 0;
  const metaLine = [
    summary.ingredient.category || '未分类',
    summary.primaryStorage || summary.ingredient.default_storage || '常温',
  ].join(' · ');
  const cardClassName = [
    'ingredient-card ingredient-card-interactive ingredient-visual-card ingredient-visual-card-catalog ingredient-work-card',
    expanded ? 'is-popover-open' : '',
    summary.alerts.length > 0 ? `ingredient-work-card-has-${alertTone}` : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <article ref={cardRef} className={cardClassName}>
      <div className="ingredient-work-card-primary">
        <div className="ingredient-work-card-toggle">
          <button
            type="button"
            className="ingredient-visual-media ingredient-visual-media-button"
            onClick={props.onDetail}
            aria-label={`查看 ${summary.ingredient.name} 详情`}
          >
            <div
              className={
                hasCustomImage
                  ? 'ingredient-visual-canvas'
                  : 'ingredient-visual-canvas ingredient-visual-canvas-placeholder'
              }
            >
              <MediaWithPlaceholder
                className="ingredient-visual-cover-frame"
                imageClassName="ingredient-visual-cover"
                src={imageUrl}
                srcSet={buildMediaSrcSet(summary.ingredient.image)}
                sizes={buildMediaSizes('card')}
                alt={summary.ingredient.name}
              />
            </div>
            <span className="ingredient-visual-entry-hint" aria-hidden="true">
              <span>↗</span>
            </span>
            {summary.alerts.length > 0 && (
              <span className={`ingredient-visual-corner ingredient-visual-corner-${alertTone}`}>
                {summary.alerts.length} 条提醒
              </span>
            )}
          </button>
          <div className="ingredient-visual-body">
            <div className="ingredient-visual-title-row">
              <h3>{summary.ingredient.name}</h3>
              <ActionButton
                tone="tertiary"
                size="compact"
                type="button"
                className="ingredient-work-card-more-icon"
                onClick={props.onToggle}
                aria-expanded={expanded}
                aria-label={`${expanded ? '关闭' : '查看'} ${summary.ingredient.name} 快捷操作`}
              >
                <span aria-hidden="true">•••</span>
              </ActionButton>
            </div>
            <p className="ingredient-visual-meta" title={metaLine}>
              {metaLine}
            </p>
            <div className={`ingredient-catalog-status tone-${status.tone}`}>
              <div className="ingredient-catalog-status-head">
                <span>{status.label}</span>
                {summary.alerts.length > 0 && <small>{summary.alerts.length} 条提醒</small>}
              </div>
              <p>{status.stockLine}</p>
              <strong>{status.hint}</strong>
            </div>
          </div>
        </div>

        <div className="ingredient-work-card-actions">
          {canDestroyExpired ? (
            <>
              <ActionButton
                tone="secondary"
                size="compact"
                type="button"
                className="ingredient-work-card-action-button ingredient-work-card-action-button-primary"
                onClick={props.onHandleAlert}
              >
                查看提醒
              </ActionButton>
              <ActionButton
                tone="secondary"
                size="compact"
                type="button"
                className="ingredient-work-card-action-button ingredient-work-card-action-button-secondary"
                onClick={props.onDetail}
              >
                查看详情
              </ActionButton>
            </>
          ) : canConsume ? (
            <>
              <ActionButton
                tone="secondary"
                size="compact"
                type="button"
                className="ingredient-work-card-action-button ingredient-work-card-action-button-primary"
                onClick={props.onConsume}
              >
                记录用量
              </ActionButton>
              <ActionButton
                tone="secondary"
                size="compact"
                type="button"
                className="ingredient-work-card-action-button ingredient-work-card-action-button-secondary"
                onClick={props.onRestock}
              >
                补货
              </ActionButton>
            </>
          ) : !tracksQuantity && summary.inventoryItems.length > 0 ? (
            <>
              <ActionButton
                tone="secondary"
                size="compact"
                type="button"
                className="ingredient-work-card-action-button ingredient-work-card-action-button-primary"
                onClick={props.onDetail}
              >
                查看详情
              </ActionButton>
              <ActionButton
                tone="secondary"
                size="compact"
                type="button"
                className="ingredient-work-card-action-button ingredient-work-card-action-button-secondary"
                onClick={props.onRestock}
              >
                补充库存
              </ActionButton>
            </>
          ) : (
            <>
              <ActionButton
                tone="secondary"
                size="compact"
                type="button"
                className="ingredient-work-card-action-button ingredient-work-card-action-button-primary"
                onClick={props.onRestock}
              >
              {summary.inventoryItems.length > 0 ? '补货' : '加入库存'}
              </ActionButton>
              <ActionButton
                tone="secondary"
                size="compact"
                type="button"
                className="ingredient-work-card-action-button ingredient-work-card-action-button-secondary"
                onClick={props.onAddShopping}
              >
                加入采购清单
              </ActionButton>
            </>
          )}
        </div>

        <div className="ingredient-work-card-footer">
          <span className="ingredient-work-card-footer-note">
            <span className="ingredient-work-card-footer-icon" aria-hidden="true">
              i
            </span>
            {!tracksQuantity ? '只记录是否有库存，做菜时不按数量扣减' : canConsume ? '可用库存不含过期记录' : '当前没有可用库存'}
          </span>
        </div>
      </div>

      {expanded && (
        <IngredientQuickDetailPopover
          summary={summary}
          anchorElement={cardRef.current}
          onClose={props.onToggle}
          onRestock={props.onRestock}
          onConsume={props.onConsume}
          onAddShopping={props.onAddShopping}
          onHandleAlert={props.onHandleAlert}
          onDetail={props.onDetail}
        />
      )}
    </article>
  );
}
