import type { ShoppingCardViewModel } from './workspaceModel';
import { resolveAssetUrl } from '../../lib/assets';
import { formatDate } from '../../lib/ui';
import { MediaWithPlaceholder } from '../MediaPlaceholder';
import { ActionButton } from '../ui-kit';

export type ShoppingHistoryRowProps = {
  card: ShoppingCardViewModel;
  onRestore: () => void;
  onDetail?: () => void;
  isBusy?: boolean;
};

export function ShoppingHistoryRow(props: ShoppingHistoryRowProps) {
  const { card } = props;
  const linkedSummary = card.linkedSummary;
  const imageUrl = resolveAssetUrl(linkedSummary?.ingredient.image?.url ?? card.linkedFood?.images?.[0]?.url);
  const hasCustomImage = Boolean(linkedSummary?.ingredient.image?.url ?? card.linkedFood?.images?.[0]?.url);
  const completedDateLabel = card.updatedAt ? formatDate(card.updatedAt) : null;
  return (
    <article className="shopping-history-row"><div className="shopping-history-row-main">
      <div className="shopping-history-row-leading"><div className={hasCustomImage ? 'shopping-history-row-media' : 'shopping-history-row-media is-placeholder'}><MediaWithPlaceholder src={imageUrl} alt={card.title} /></div></div>
      <div className="shopping-history-row-copy"><div className="shopping-history-row-head"><h4 className="shopping-history-row-title">{card.title}</h4><strong className="shopping-history-row-quantity">{card.quantityLabel}</strong><span className="shopping-history-row-source">{card.sourceLabel}</span>{completedDateLabel && <span className="shopping-history-row-date-tag"><span className="shopping-history-row-date-icon" aria-hidden="true">📅</span>{completedDateLabel} 已买</span>}</div><p className="shopping-history-row-meta">{card.reasonLabel ? `${card.reasonLabel} · ` : ''}{card.contextLine}</p></div>
      <div className="shopping-history-row-actions">{props.onDetail ? <ActionButton tone="tertiary" size="compact" type="button" className="shopping-history-detail-action" onClick={props.onDetail} disabled={props.isBusy}>查看详情</ActionButton> : null}<ActionButton tone="secondary" size="compact" type="button" className="shopping-history-restore-action" onClick={props.onRestore} disabled={props.isBusy}>再次加入采购清单</ActionButton></div>
    </div></article>
  );
}
