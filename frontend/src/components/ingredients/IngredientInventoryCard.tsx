import type { IngredientSummaryViewModel } from './workspaceModel';
import {
  buildInventoryCardPresentation,
  buildInventoryCardStatus,
  buildInventoryTotalLabel,
  countDisposableExpiredInventoryItems,
  getIngredientAlertTone,
} from './workspaceModel';
import { buildMediaSizes, buildMediaSrcSet, resolveMediaUrl } from '../../lib/assets';
import { businessDateKey } from '../../lib/date';
import { formatDate } from '../../lib/ui';
import { tracksIngredientQuantity } from '../../lib/ingredientTracking';
import { MediaWithPlaceholder } from '../MediaPlaceholder';
import { ActionButton } from '../ui-kit';

export type IngredientInventoryCardProps = {
  summary: IngredientSummaryViewModel;
  onRestock: () => void;
  onConsume: () => void;
  onAddShopping: () => void;
  onDetail: () => void;
  onDestroyExpired: () => void;
};

export function IngredientInventoryCard(props: IngredientInventoryCardProps) {
  const { summary } = props;
  const status = buildInventoryCardStatus(summary);
  const presentation = buildInventoryCardPresentation(summary, businessDateKey());
  const canDestroyExpired = countDisposableExpiredInventoryItems(summary, businessDateKey()) > 0;
  const alertTone = summary.alerts.length > 0 ? getIngredientAlertTone(summary) : null;
  const imageUrl = resolveMediaUrl(summary.ingredient.image, 'card');
  const hasCustomImage = Boolean(summary.ingredient.image?.url);
  const tracksQuantity = tracksIngredientQuantity(summary.ingredient);
  const metaLine = [summary.ingredient.category || '未分类', summary.primaryStorage].join(' · ');
  const totalInventoryLabel = buildInventoryTotalLabel(summary);
  const cardClassName = [
    'ingredient-card ingredient-card-interactive ingredient-visual-card ingredient-visual-card-summary ingredient-visual-card-inventory ingredient-work-card inventory-ingredient-card',
    `tone-${status.tone}`,
    alertTone ? `ingredient-work-card-has-${alertTone}` : '',
  ].filter(Boolean).join(' ');

  return (
    <article className={cardClassName}>
      <div className="ingredient-work-card-primary">
        <div className="ingredient-work-card-toggle">
          <button type="button" className="ingredient-visual-media ingredient-visual-media-button inventory-ingredient-card-media" onClick={props.onDetail} aria-label={`查看 ${summary.ingredient.name} 详情`}>
            <div className={hasCustomImage ? 'ingredient-visual-canvas' : 'ingredient-visual-canvas ingredient-visual-canvas-placeholder'}>
              <MediaWithPlaceholder className="ingredient-visual-cover-frame" imageClassName="ingredient-visual-cover" src={imageUrl} srcSet={buildMediaSrcSet(summary.ingredient.image)} sizes={buildMediaSizes('card')} alt={summary.ingredient.name} />
            </div>
            <span className="ingredient-visual-entry-hint" aria-hidden="true"><span>↗</span></span>
            {alertTone && <span className={`ingredient-visual-corner ingredient-visual-corner-${alertTone}`}>{summary.alerts.length} 条提醒</span>}
          </button>
          <div className="ingredient-visual-body inventory-ingredient-card-body">
            <div className="ingredient-visual-title-row inventory-ingredient-card-title-row">
              <h3>{summary.ingredient.name}</h3>
              <span className={`inventory-maintenance-chip is-confirmation is-${presentation.confirmationTone}`} title={presentation.lastConfirmedAt ? `上次确认 ${formatDate(presentation.lastConfirmedAt.slice(0, 10))}` : '未确认库存'}>{presentation.confirmationLabel}</span>
            </div>
            <p className="ingredient-visual-meta" title={metaLine}>{metaLine}</p>
            <div className="inventory-ingredient-card-stockline">
              <div className="inventory-ingredient-card-stockline-head"><span className="inventory-ingredient-card-stockline-label">可用库存</span>{presentation.hasExpiryInfo && presentation.expiryLabel && presentation.expiryTone ? <span className={`inventory-ingredient-card-expiry-badge tone-${presentation.expiryTone}`} title={`最早 ${presentation.expiryDateLabel} 到期`}>{presentation.expiryLabel}</span> : null}</div>
              <strong>{presentation.headline}</strong><p title={presentation.secondary}>{presentation.secondary}</p>
              <div className="inventory-ingredient-card-data-row">{tracksQuantity ? <><span>总库存 {totalInventoryLabel}</span><span>{summary.inventoryItems.length} 批库存</span></> : <><span>库存状态 {totalInventoryLabel}</span><span>只记录有无</span></>}<span>{summary.alerts.length} 条提醒</span></div>
            </div>
          </div>
        </div>
        <div className="ingredient-work-card-actions inventory-ingredient-card-actions">
          {canDestroyExpired ? <><ActionButton tone="secondary" size="compact" type="button" className="ingredient-work-card-action-button ingredient-work-card-action-button-primary" onClick={props.onDestroyExpired} title="查看并确认处理已过期库存">查看提醒</ActionButton><ActionButton tone="secondary" size="compact" type="button" className="ingredient-work-card-action-button ingredient-work-card-action-button-secondary" onClick={props.onDetail}>查看详情</ActionButton></> : tracksQuantity && summary.quantitySummaries.length > 0 ? <><ActionButton tone="secondary" size="compact" type="button" className="ingredient-work-card-action-button ingredient-work-card-action-button-primary" onClick={props.onConsume}>记录用量</ActionButton><ActionButton tone="secondary" size="compact" type="button" className="ingredient-work-card-action-button ingredient-work-card-action-button-secondary" onClick={props.onRestock}>补货</ActionButton></> : !tracksQuantity && summary.inventoryItems.length > 0 ? <><ActionButton tone="secondary" size="compact" type="button" className="ingredient-work-card-action-button ingredient-work-card-action-button-primary" onClick={props.onDetail}>查看详情</ActionButton><ActionButton tone="secondary" size="compact" type="button" className="ingredient-work-card-action-button ingredient-work-card-action-button-secondary" onClick={props.onRestock}>补充库存</ActionButton></> : <><ActionButton tone="secondary" size="compact" type="button" className="ingredient-work-card-action-button ingredient-work-card-action-button-primary" onClick={props.onRestock}>{summary.inventoryItems.length > 0 ? '补货' : '加入库存'}</ActionButton><ActionButton tone="secondary" size="compact" type="button" className="ingredient-work-card-action-button ingredient-work-card-action-button-secondary" onClick={props.onAddShopping}>加入采购清单</ActionButton></>}
        </div>
        <div className="ingredient-work-card-footer inventory-ingredient-card-footer"><span className="ingredient-work-card-footer-note inventory-ingredient-card-footer-note">{presentation.footerNote}</span></div>
      </div>
    </article>
  );
}
