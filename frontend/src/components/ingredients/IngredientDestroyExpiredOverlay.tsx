import type { FormEvent } from 'react';
import { formatDate, formatRelativeDays, INVENTORY_STATUS_LABELS } from '../../lib/ui';
import { MediaWithPlaceholder } from '../MediaPlaceholder';
import { Badge, EmptyState, FormActions, WorkspaceModal } from '../ui-kit';
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
  selectedDestroyExpiredPreview?: string;
  selectedDestroyExpiredMeta: string[];
  destroyExpiredItems: DestroyExpiredItem[];
  destroyExpiredHeadline: string;
  submitDestroyExpired: (event: FormEvent<HTMLFormElement>) => Promise<void>;
  isDisposingExpiredInventory?: boolean;
};

export function IngredientDestroyExpiredOverlay(props: IngredientDestroyExpiredOverlayProps) {
  const destroyExpiredFormId = 'ingredient-destroy-expired-overlay-form';

  return (
    <WorkspaceModal
      title="销毁已过期批次"
      description="清零过期批次剩余量，历史记录会保留。"
      closeLabel="关闭"
      closeAriaLabel="关闭"
      className="workspace-modal-wide destroy-expired-modal"
      onClose={props.closeOverlay}
      footerInfo={
        <div className="destroy-expired-footer-summary">
          <span>将处理</span>
          <strong>{props.destroyExpiredItems.length} 条过期批次</strong>
          <p>
            {props.destroyExpiredItems.length > 0
              ? '剩余量会清零，历史记录和日志保留。'
              : '当前没有可销毁的过期批次。'}
          </p>
        </div>
      }
      footerActions={
        <FormActions
          className="destroy-expired-actions"
          primaryLabel="确认销毁"
          primaryType="submit"
          primaryForm={destroyExpiredFormId}
          primaryTone="danger"
          primaryDisabled={props.destroyExpiredItems.length === 0}
          isSubmitting={Boolean(props.isDisposingExpiredInventory)}
          secondaryLabel="取消"
          onSecondary={props.closeOverlay}
        />
      }
    >
      <form
        id={destroyExpiredFormId}
        className="destroy-expired-form"
        onSubmit={(event) => void props.submitDestroyExpired(event)}
      >
        <div className="destroy-expired-scroll">
          <section className="ingredients-restock-identity-card destroy-expired-summary-card">
            <div className="ingredients-restock-identity-media">
              <MediaWithPlaceholder
                src={props.selectedDestroyExpiredPreview}
                alt={props.selectedDestroyExpiredSummary.ingredient.name}
              />
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
                  <article key={item.id} className="destroy-expired-row">
                    <div className="destroy-expired-row-main">
                      <strong>{item.remainingLabel}</strong>
                      <span>{item.storageLocation}</span>
                    </div>
                    <div className="destroy-expired-row-meta">
                      <span className="is-danger">已过期 {formatRelativeDays(item.expiryDate)}</span>
                      <span>{INVENTORY_STATUS_LABELS[item.status]}</span>
                      <span>购 {formatDate(item.purchaseDate)}</span>
                      <span>到期 {formatDate(item.expiryDate)}</span>
                    </div>
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
      </form>
    </WorkspaceModal>
  );
}
