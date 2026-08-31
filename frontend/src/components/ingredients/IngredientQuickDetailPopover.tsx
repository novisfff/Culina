import { createPortal } from 'react-dom';
import { useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { buildCatalogCardStatus, buildCatalogExpandedNote, buildInventorySummaryLine, type IngredientSummaryViewModel } from './workspaceModel';
import { resolveMediaUrl } from '../../lib/assets';
import { formatDate } from '../../lib/ui';
import { MediaWithPlaceholder } from '../MediaPlaceholder';
import { WorkspaceOverlayFrame } from '../ui-kit';
import { tracksIngredientQuantity } from '../../lib/ingredientTracking';

type IngredientQuickDetailPopoverProps = {
  summary: IngredientSummaryViewModel;
  anchorElement: HTMLElement | null;
  onClose: () => void;
  onRestock: () => void;
  onConsume: () => void;
  onAddShopping: () => void;
  onHandleAlert: () => void;
  onDetail: () => void;
};

export function IngredientQuickDetailPopover(props: IngredientQuickDetailPopoverProps) {
  const { summary } = props;
  const imageUrl = resolveMediaUrl(summary.ingredient.image, 'card');
  const hasCustomImage = Boolean(summary.ingredient.image?.url);
  const status = buildCatalogCardStatus(summary);
  const tracksQuantity = tracksIngredientQuantity(summary.ingredient);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const [placement, setPlacement] = useState<'left' | 'right'>('left');
  const [position, setPosition] = useState<CSSProperties>({ top: 16, left: 16 });

  useLayoutEffect(() => {
    const node = popoverRef.current;
    if (!node) return;
    const parentCard = props.anchorElement;
    if (!parentCard) return;

    const parentRect = parentCard.getBoundingClientRect();
    const popoverRect = node.getBoundingClientRect();
    const popoverWidth = node.offsetWidth || popoverRect.width;
    const popoverHeight = node.offsetHeight || popoverRect.height;
    const alignsRight = window.innerWidth - parentRect.right < 300;
    const desiredLeft = alignsRight
      ? parentRect.right - popoverWidth - 10
      : parentRect.left + 10;
    const left = Math.min(
      Math.max(16, desiredLeft),
      Math.max(16, window.innerWidth - popoverWidth - 16),
    );
    const top = Math.min(
      Math.max(16, parentRect.top + 10),
      Math.max(16, window.innerHeight - popoverHeight - 16),
    );

    setPlacement(alignsRight ? 'right' : 'left');
    setPosition({ top, left });
  }, [props.anchorElement]);

  return createPortal(
    <WorkspaceOverlayFrame
      rootClassName="ingredient-quick-detail-overlay-root"
      backdropClassName="ingredient-quick-detail-backdrop"
      labelledBy="quick-popover-title"
      onClose={props.onClose}
    >
      <div
        ref={popoverRef}
        className={`ingredient-quick-detail-popover place-${placement}`}
        style={position}
        onClick={(e) => e.stopPropagation()}
        data-workspace-overlay-panel="true"
      >
        <div className="ingredient-quick-detail-head">
          <div className="ingredient-quick-detail-media-frame">
            <div
              className={
                hasCustomImage
                  ? 'ingredient-quick-detail-media'
                  : 'ingredient-quick-detail-media is-placeholder'
              }
            >
              <MediaWithPlaceholder src={imageUrl} alt={summary.ingredient.name} />
            </div>
          </div>
          <div className="ingredient-quick-detail-titles">
            <div className="ingredient-quick-detail-title-row">
              <h4 id="quick-popover-title" className="ingredient-quick-detail-title">
                {summary.ingredient.name}
              </h4>
              <span className="ingredient-quick-detail-category-badge">
                {summary.ingredient.category || '未分类'} · {summary.primaryStorage || summary.ingredient.default_storage || '常温'}
              </span>
            </div>
          </div>
          <button
            type="button"
            className="ingredient-quick-detail-close-btn"
            onClick={props.onClose}
            aria-label="关闭浮窗"
          >
            ✕
          </button>
        </div>

        <div className={`ingredient-quick-detail-status-banner tone-${status.tone}`}>
          <div className="ingredient-quick-detail-status-banner-head">
            <span className="ingredient-quick-detail-status-icon" aria-hidden="true">
              {summary.alerts.length > 0 ? '⚠️' : '🟢'}
            </span>
            <strong>
              {summary.alerts.length > 0 ? `${summary.alerts.length} 条提醒需要处理` : '库存正常'}
            </strong>
          </div>
          {summary.alerts.length > 0 ? (
            <div className="ingredient-quick-detail-alerts-list">
              {summary.alerts.map((alert) => (
                <span key={alert.id} className={`ingredient-quick-detail-alert-pill tone-${alert.tone}`}>
                  {alert.title}
                </span>
              ))}
            </div>
          ) : null}
        </div>

        <div className="ingredient-quick-detail-grid">
          <div className="ingredient-quick-detail-card">
            <span className="ingredient-quick-detail-card-label">当前库存</span>
            <strong className="ingredient-quick-detail-card-value">{buildInventorySummaryLine(summary)}</strong>
          </div>
          <div className="ingredient-quick-detail-card">
            <span className="ingredient-quick-detail-card-label">最近补货</span>
            <strong className="ingredient-quick-detail-card-value">
              {summary.latestPurchaseDate ? formatDate(summary.latestPurchaseDate) : '还没有补货记录'}
            </strong>
          </div>
          <div className="ingredient-quick-detail-card ingredient-quick-detail-card-full">
            <span className="ingredient-quick-detail-card-label">备注与用途</span>
            <p className="ingredient-quick-detail-card-text">{buildCatalogExpandedNote(summary)}</p>
          </div>
        </div>

        <div className="ingredient-quick-detail-footer">
          <button
            type="button"
            className="ingredient-quick-detail-full-link"
            onClick={() => {
              props.onClose();
              props.onDetail();
            }}
          >
            查看详情 ↗
          </button>
        </div>
      </div>
    </WorkspaceOverlayFrame>,
    document.body,
  );
}
