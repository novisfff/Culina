import type { FormEvent } from 'react';
import { formatDate, formatRelativeDays, INVENTORY_STATUS_LABELS } from '../../lib/ui';
import { ActionButton, Badge, EmptyState, WorkspaceModal } from '../ui-kit';
import type { IngredientSummaryViewModel } from './workspaceModel';

type DestroyExpiredItem = {
  id: string;
  remainingLabel: string;
  storageLocation: string;
  expiryDate: string;
  status: keyof typeof INVENTORY_STATUS_LABELS;
  purchaseDate: string;
  notes: string;
};

type IngredientDestroyExpiredOverlayProps = {
  closeOverlay: () => void;
  selectedDestroyExpiredSummary: IngredientSummaryViewModel;
  selectedDestroyExpiredPreview: string;
  selectedDestroyExpiredMeta: string[];
  destroyExpiredItems: DestroyExpiredItem[];
  destroyExpiredHeadline: string;
  submitDestroyExpired: (event: FormEvent<HTMLFormElement>) => Promise<void>;
  isDisposingExpiredInventory?: boolean;
};

export function IngredientDestroyExpiredOverlay(props: IngredientDestroyExpiredOverlayProps) {
  return (
    <WorkspaceModal
      title="销毁已过期批次"
      description="清零过期批次剩余量，历史记录会保留。"
      closeLabel="关闭"
      closeAriaLabel="关闭"
      className="workspace-modal-wide destroy-expired-modal"
      onClose={props.closeOverlay}
    >
      <form className="destroy-expired-form" onSubmit={(event) => void props.submitDestroyExpired(event)}>
        <div className="destroy-expired-scroll">
          <section className="ingredients-restock-identity-card destroy-expired-summary-card">
            <div className="ingredients-restock-identity-media">
              <img src={props.selectedDestroyExpiredPreview} alt={props.selectedDestroyExpiredSummary.ingredient.name} />
            </div>
            <div className="ingredients-restock-identity-copy">
              <div className="ingredients-restock-identity-head">
                <div>
                  <h4>{props.selectedDestroyExpiredSummary.ingredient.name}</h4>
                  <p>{props.selectedDestroyExpiredMeta.join(' · ')}</p>
                </div>
                <div className="destroy-expired-summary-badges">
                  <Badge>{props.destroyExpiredItems.length} 条待销毁</Badge>
                  <Badge>{props.destroyExpiredHeadline}</Badge>
                </div>
              </div>
              <div className="destroy-expired-summary-grid">
                <article className="destroy-expired-summary-metric is-primary">
                  <span>本次处理范围</span>
                  <strong>{props.destroyExpiredItems.length} 条过期批次</strong>
                  <p>确认后清零剩余量。</p>
                </article>
              </div>
            </div>
          </section>

          <section className="ingredients-restock-field-group destroy-expired-list-section">
            <div className="ingredients-restock-field-head">
              <span>待处理批次</span>
            </div>
            {props.destroyExpiredItems.length > 0 ? (
              <div className="destroy-expired-list">
                {props.destroyExpiredItems.map((item) => (
                  <article key={item.id} className="destroy-expired-item">
                    <div className="destroy-expired-item-head">
                      <div className="destroy-expired-item-title">
                        <strong>{item.remainingLabel}</strong>
                        <span>{item.storageLocation}</span>
                      </div>
                      <div className="destroy-expired-item-badges">
                        <Badge className="destroy-expired-item-badge is-danger">
                          已过期 {formatRelativeDays(item.expiryDate)}
                        </Badge>
                        <Badge>{INVENTORY_STATUS_LABELS[item.status]}</Badge>
                      </div>
                    </div>
                    <div className="destroy-expired-item-meta">
                      <span>购买于 {formatDate(item.purchaseDate)}</span>
                      <span>到期日 {formatDate(item.expiryDate)}</span>
                    </div>
                    <p className="destroy-expired-item-note" title={item.notes || '当前没有备注'}>
                      {item.notes || '当前没有备注'}
                    </p>
                  </article>
                ))}
              </div>
            ) : (
              <EmptyState
                title="当前没有可销毁的批次"
                description="这份食材现在没有“已过期且仍有剩余量”的批次，可以直接关闭这个面板。"
              />
            )}
          </section>
        </div>

        <div className="destroy-expired-footer-bar">
          <div className="destroy-expired-footer-summary">
            <span>将处理</span>
            <strong>{props.destroyExpiredItems.length} 条过期批次</strong>
            <p>
              {props.destroyExpiredItems.length > 0
                ? '剩余量会清零，历史记录和日志保留。'
                : '当前没有可销毁的过期批次。'}
            </p>
          </div>
          <div className="workspace-overlay-actions">
            <ActionButton tone="secondary" type="button" onClick={props.closeOverlay}>
              取消
            </ActionButton>
            <ActionButton
              tone="primary"
              type="submit"
              disabled={props.isDisposingExpiredInventory || props.destroyExpiredItems.length === 0}
            >
              {props.isDisposingExpiredInventory ? '销毁中...' : '确认销毁'}
            </ActionButton>
          </div>
        </div>
      </form>
    </WorkspaceModal>
  );
}
