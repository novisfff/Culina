import { ActionButton } from '../ui-kit';
import { MediaWithPlaceholder } from '../MediaPlaceholder';
import { resolveAssetUrl } from '../../lib/assets';
import type { ShoppingCardViewModel } from './workspaceModel';

export type ShoppingWorkRowProps = {
  card: ShoppingCardViewModel;
  onComplete: () => void;
  onDetail?: () => void;
  isBusy?: boolean;
};

/** Presentational shopping row; completion and navigation remain owned by the workspace port. */
export function ShoppingWorkRow(props: ShoppingWorkRowProps) {
  const { card } = props;
  const linkedSummary = card.linkedSummary;
  const imageUrl = resolveAssetUrl(linkedSummary?.ingredient.image?.url ?? card.linkedFood?.images?.[0]?.url);
  const hasCustomImage = Boolean(linkedSummary?.ingredient.image?.url ?? card.linkedFood?.images?.[0]?.url);
  const footerNote = card.statusTone === 'danger'
    ? '已过期，建议优先购买并加入库存。'
    : card.hasAttention
      ? '有库存提醒，建议优先购买并加入库存。'
      : card.footerNote;
  const rowClassName = ['shopping-work-row', `tone-${card.tone}`, card.hasAttention ? 'has-attention' : '']
    .filter(Boolean)
    .join(' ');

  return (
    <article className={rowClassName}>
      <div className="shopping-work-row-accent-bar" aria-hidden="true" />
      <div className="shopping-work-row-main">
        <div className="shopping-work-row-leading">
          <div className={hasCustomImage ? 'shopping-work-row-media' : 'shopping-work-row-media is-placeholder'}>
            <MediaWithPlaceholder src={imageUrl} alt={card.title} />
          </div>
        </div>
        <div className="shopping-work-row-copy">
          <div className="shopping-work-row-head">
            <div className="shopping-work-row-titleblock">
              <h3 className="shopping-work-row-title">{card.title}</h3>
              <strong className="shopping-work-row-quantity">{card.headline}</strong>
              <div className="shopping-work-row-badges">
                <span className={`shopping-work-row-source tone-${card.tone}`}>{card.sourceLabel}</span>
                <span className={`shopping-work-row-status tone-${card.statusTone}`}>{card.statusLabel}</span>
              </div>
            </div>
          </div>
          <div className="shopping-work-row-meta-line">
            <p className="shopping-work-row-subline" title={card.subline}>{card.subline}</p>
            {card.contextTags.length > 0 ? (
              <div className="shopping-work-row-context">
                {card.contextTags.map((tag) => (
                  <span key={`${card.shoppingItem.id}-${tag}`} className="shopping-work-row-context-tag">{tag}</span>
                ))}
              </div>
            ) : null}
          </div>
          {footerNote ? (
            <div className="shopping-work-row-inline-note">
              <span className="shopping-work-row-inline-note-icon" aria-hidden="true">💡</span>
              <span className="shopping-work-row-inline-note-text">{footerNote}</span>
            </div>
          ) : null}
        </div>
        <div className="shopping-work-row-actions">
          <ActionButton tone="primary" type="button" className="shopping-work-row-primary-action" onClick={props.onComplete} disabled={props.isBusy}>
            已购买并加入库存
          </ActionButton>
          {props.onDetail ? (
            <ActionButton tone="secondary" size="compact" type="button" className="shopping-work-row-detail-action" onClick={props.onDetail} disabled={props.isBusy}>
              查看详情
            </ActionButton>
          ) : (
            <div className="shopping-work-row-action-note">{card.linkedFood ? '买回后补充成品库存' : '买回后按当前名称加入库存'}</div>
          )}
        </div>
      </div>
    </article>
  );
}
