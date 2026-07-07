import type { FormEvent, ReactNode } from 'react';
import { formatDate, formatRelativeDays, INVENTORY_STATUS_LABELS } from '../../lib/ui';
import { MediaWithPlaceholder } from '../MediaPlaceholder';
import { Badge, EmptyState, FormActions, WorkspaceModal, WorkspaceOverlayFrame } from '../ui-kit';
import type { DisposableExpiredInventoryItemViewModel, IngredientSummaryViewModel } from './workspaceModel';

export type DestroyExpiredInventoryDialogProps = {
  closeOverlay: () => void;
  summary: IngredientSummaryViewModel;
  previewUrl?: string;
  meta: string[];
  items: DisposableExpiredInventoryItemViewModel[];
  headline: string;
  submit: (event: FormEvent<HTMLFormElement>) => Promise<void>;
  isSubmitting?: boolean;
  formId?: string;
  overlayRootClassName?: string;
  description?: string;
  footerSummaryIntro?: string;
  footerSummaryDetail?: string;
  summaryMetrics?: ReactNode;
  listTitle?: string;
  listDescription?: string;
  emptyDescription?: string;
};

export function DestroyExpiredInventoryDialog(props: DestroyExpiredInventoryDialogProps) {
  const destroyExpiredFormId = props.formId ?? 'ingredient-destroy-expired-overlay-form';
  const isSubmitting = Boolean(props.isSubmitting);
  const closeIfAllowed = () => {
    if (!isSubmitting) {
      props.closeOverlay();
    }
  };

  return (
    <WorkspaceOverlayFrame
      rootClassName={props.overlayRootClassName}
      closeOnBackdrop={!isSubmitting}
      onClose={closeIfAllowed}
    >
      <WorkspaceModal
        title="销毁已过期批次"
        description={props.description ?? '清零过期批次剩余量，历史记录会保留。'}
        closeLabel="关闭"
        closeAriaLabel="关闭"
        className="workspace-modal-wide destroy-expired-modal"
        onClose={closeIfAllowed}
        footerInfo={
          <div className="destroy-expired-footer-summary">
            <span>{props.footerSummaryIntro ?? '将处理'}</span>
            <strong>{props.items.length} 条过期批次</strong>
            <p>
              {props.items.length > 0
                ? props.footerSummaryDetail ?? '剩余量会清零，历史记录和日志保留。'
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
            primaryDisabled={props.items.length === 0}
            isSubmitting={isSubmitting}
            secondaryLabel="取消"
            onSecondary={closeIfAllowed}
          />
        }
      >
        <form
          id={destroyExpiredFormId}
          className="destroy-expired-form"
          onSubmit={(event) => void props.submit(event)}
        >
          <div className="destroy-expired-scroll">
            <section className="ingredients-restock-identity-card destroy-expired-summary-card">
              <div className="ingredients-restock-identity-media">
                <MediaWithPlaceholder src={props.previewUrl} alt={props.summary.ingredient.name} />
              </div>
              <div className="ingredients-restock-identity-copy">
                <div className="ingredients-restock-identity-head">
                  <div>
                    <h4>{props.summary.ingredient.name}</h4>
                    <p>{props.meta.join(' · ')}</p>
                  </div>
                  <div className="destroy-expired-summary-badges">
                    <Badge>{props.items.length} 条待销毁</Badge>
                    <Badge>{props.headline}</Badge>
                  </div>
                </div>
                <div className="destroy-expired-summary-grid">
                  {props.summaryMetrics ?? (
                    <article className="destroy-expired-summary-metric is-primary">
                      <span>本次处理范围</span>
                      <strong>{props.items.length} 条过期批次</strong>
                      <p>确认后清零剩余量。</p>
                    </article>
                  )}
                </div>
              </div>
            </section>

            <section className="ingredients-restock-field-group destroy-expired-list-section">
              <div className="ingredients-restock-field-head">
                <span>{props.listTitle ?? '待处理批次'}</span>
                {props.listDescription ? <p className="subtle">{props.listDescription}</p> : null}
              </div>
              {props.items.length > 0 ? (
                <div className="destroy-expired-list">
                  {props.items.map((item) => (
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
                  description={props.emptyDescription ?? '这份食材现在没有“已过期且仍有剩余量”的批次，可以直接关闭这个面板。'}
                />
              )}
            </section>
          </div>
        </form>
      </WorkspaceModal>
    </WorkspaceOverlayFrame>
  );
}

export { DestroyExpiredInventoryDialog as IngredientDestroyExpiredOverlay };
