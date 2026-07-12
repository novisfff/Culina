import { useEffect, useMemo, useState } from 'react';
import type {
  InventoryOperationDetail,
  InventoryOperationResult,
  InventoryOperationSummary,
} from '../../api/types';
import {
  ActionButton,
  FormActions,
  MobileActionBar,
  StateBlock,
  WorkspaceModal,
  WorkspaceOverlayFrame,
} from '../../components/ui-kit';
import { formatDateTime } from '../../lib/ui';
import { isOperationStillRevertible, operationTypeLabel } from './InventoryOperationBanner';

export type InventoryOperationHistoryDialogProps = {
  open: boolean;
  operations: InventoryOperationSummary[];
  loading?: boolean;
  busy?: boolean;
  errorMessage?: string | null;
  selectedOperationId?: string | null;
  detail?: InventoryOperationDetail | null;
  detailLoading?: boolean;
  detailError?: string | null;
  conflictMessage?: string | null;
  initialOperationId?: string | null;
  overlayRootClassName?: string;
  now?: () => number;
  onClose: () => void;
  onSelectOperation: (operationId: string) => void;
  onLoadDetail?: (operationId: string) => void;
  onRevert: (operationId: string) => void;
  onRetry?: () => void;
};

function compactTimeLabel(iso: string) {
  try {
    return formatDateTime(iso);
  } catch {
    return iso;
  }
}

function changeTypeLabel(changeType: string) {
  if (changeType === 'create') return '新增';
  if (changeType === 'delete') return '删除';
  return '更新';
}

function statusLabel(operation: InventoryOperationResult, nowMs: number) {
  if (operation.status === 'reverted') return '已撤销';
  if (isOperationStillRevertible(operation, nowMs)) return '可撤销';
  return '已生效';
}

export function InventoryOperationHistoryDialog(props: InventoryOperationHistoryDialogProps) {
  const busy = Boolean(props.busy);
  const loading = Boolean(props.loading);
  const nowFn = props.now ?? Date.now;
  const [nowMs, setNowMs] = useState(() => nowFn());
  const [confirmingOperationId, setConfirmingOperationId] = useState<string | null>(null);

  useEffect(() => {
    if (!props.open) return;
    setNowMs(nowFn());
    const timer = window.setInterval(() => setNowMs(nowFn()), 1000);
    return () => window.clearInterval(timer);
  }, [nowFn, props.open]);

  useEffect(() => {
    if (!props.open) {
      setConfirmingOperationId(null);
    }
  }, [props.open]);

  useEffect(() => {
    if (!props.open || !props.initialOperationId) return;
    props.onSelectOperation(props.initialOperationId);
    props.onLoadDetail?.(props.initialOperationId);
    // Intentionally run when open/initial id changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.open, props.initialOperationId]);

  const selectedId = props.selectedOperationId ?? null;
  const selectedSummary = useMemo(
    () => props.operations.find((operation) => operation.operation_id === selectedId) ?? null,
    [props.operations, selectedId],
  );
  const detail = props.detail && props.detail.operation_id === selectedId ? props.detail : null;
  const canRevertSelected = detail
    ? isOperationStillRevertible(detail, nowMs)
    : selectedSummary
      ? isOperationStillRevertible(selectedSummary, nowMs)
      : false;

  if (!props.open) {
    return null;
  }

  const closeIfAllowed = () => {
    if (!busy) props.onClose();
  };

  const footerActions = (
    <FormActions
      className="inventory-maintenance-actions"
      primaryLabel="关闭"
      isSubmitting={busy}
      onPrimary={closeIfAllowed}
      secondaryLabel={
        canRevertSelected
          ? confirmingOperationId === selectedId
            ? '确认撤销整次操作'
            : '撤销本次操作'
          : undefined
      }
      onSecondary={
        canRevertSelected && selectedId
          ? () => {
              if (busy) return;
              if (confirmingOperationId !== selectedId) {
                setConfirmingOperationId(selectedId);
                return;
              }
              props.onRevert(selectedId);
              setConfirmingOperationId(null);
            }
          : undefined
      }
    />
  );

  return (
    <WorkspaceOverlayFrame
      rootClassName={['inventory-maintenance-overlay-root', props.overlayRootClassName]
        .filter(Boolean)
        .join(' ')}
      closeOnBackdrop={!busy}
      busy={busy}
      labelledBy="inventory-operation-history-title"
      onClose={closeIfAllowed}
    >
      <WorkspaceModal
        title="库存操作历史"
        titleId="inventory-operation-history-title"
        description="查看最近 20 次家庭库存操作；撤销会回退整次操作。"
        eyebrow="操作历史"
        closeLabel="关闭"
        closeAriaLabel="关闭操作历史"
        className="workspace-modal-wide inventory-maintenance-modal inventory-operation-history-modal"
        onClose={closeIfAllowed}
        busy={busy}
        footerInfo={
          <div className="inventory-maintenance-footer-summary">
            <span>最近记录</span>
            <strong>{props.operations.length} 条</strong>
            <p>{canRevertSelected ? '撤销作用于整次操作' : '仅可查看历史详情'}</p>
          </div>
        }
        footerActions={
          <>
            <div className="inventory-maintenance-desktop-actions">{footerActions}</div>
            <MobileActionBar className="inventory-maintenance-mobile-actions">{footerActions}</MobileActionBar>
          </>
        }
      >
        <div className="inventory-maintenance-scroll inventory-operation-history-layout">
          <div className="inventory-maintenance-live" aria-live="polite">
            {props.conflictMessage || props.errorMessage || props.detailError || ''}
          </div>

          {props.conflictMessage ? (
            <div className="inventory-maintenance-conflict" role="status">
              <strong>暂时无法撤销</strong>
              <p>{props.conflictMessage}</p>
              {props.onRetry ? (
                <ActionButton tone="secondary" size="compact" type="button" disabled={busy} onClick={props.onRetry}>
                  重试
                </ActionButton>
              ) : null}
            </div>
          ) : null}

          {props.errorMessage && !props.conflictMessage ? (
            <div className="inventory-maintenance-error" role="alert">
              {props.errorMessage}
            </div>
          ) : null}

          {loading ? (
            <StateBlock
              status="loading"
              title="正在加载操作历史"
              description="稍等一下，正在读取最近的家庭库存操作。"
              className="inventory-maintenance-state"
            />
          ) : null}

          {!loading && props.operations.length === 0 ? (
            <StateBlock
              status="empty"
              title="还没有可查看的操作"
              description="完成采购入库或快速盘点后，最近 20 次操作会出现在这里。"
              className="inventory-maintenance-state"
            />
          ) : null}

          {!loading && props.operations.length > 0 ? (
            <div className="inventory-operation-history-columns">
              <section className="inventory-maintenance-section" aria-label="最近操作">
                <div className="inventory-maintenance-section-head">
                  <span>最近 20 次</span>
                  <em>{props.operations.length}</em>
                </div>
                <div className="inventory-operation-history-list">
                  {props.operations.slice(0, 20).map((operation) => {
                    const active = operation.operation_id === selectedId;
                    return (
                      <button
                        key={operation.operation_id}
                        type="button"
                        className={[
                          'inventory-operation-history-item',
                          active ? 'is-selected' : '',
                          isOperationStillRevertible(operation, nowMs) ? 'is-revertible' : '',
                        ]
                          .filter(Boolean)
                          .join(' ')}
                        disabled={busy}
                        onClick={() => {
                          props.onSelectOperation(operation.operation_id);
                          props.onLoadDetail?.(operation.operation_id);
                          setConfirmingOperationId(null);
                        }}
                      >
                        <div className="inventory-operation-history-item-title">
                          <strong>{operation.summary.title || operationTypeLabel(operation.operation_type)}</strong>
                          <span>{statusLabel(operation, nowMs)}</span>
                        </div>
                        <p className="subtle">
                          {operation.actor_display_name} · {compactTimeLabel(operation.applied_at)}
                        </p>
                        <p className="subtle">{operation.summary.description}</p>
                      </button>
                    );
                  })}
                </div>
              </section>

              <section className="inventory-maintenance-section" aria-label="操作详情">
                <div className="inventory-maintenance-section-head">
                  <span>详情</span>
                  <em>{selectedSummary ? statusLabel(selectedSummary, nowMs) : '未选择'}</em>
                </div>

                {!selectedId ? (
                  <p className="subtle">选择左侧一条操作，查看变更明细。</p>
                ) : null}

                {selectedId && props.detailLoading ? (
                  <StateBlock
                    status="loading"
                    title="正在加载详情"
                    description="正在读取这次操作的变更明细。"
                    className="inventory-maintenance-state"
                  />
                ) : null}

                {selectedId && props.detailError ? (
                  <div className="inventory-maintenance-error" role="alert">
                    {props.detailError}
                  </div>
                ) : null}

                {selectedSummary && !props.detailLoading ? (
                  <div className="inventory-operation-history-detail">
                    <div className="inventory-maintenance-summary-card">
                      <p className="eyebrow">
                        {selectedSummary.operation_type === 'shopping_intake' ? '采购入库' : '快速盘点'}
                      </p>
                      <h4>{selectedSummary.summary.title || operationTypeLabel(selectedSummary.operation_type)}</h4>
                      <p className="subtle">{selectedSummary.summary.description}</p>
                      <p className="subtle">
                        {selectedSummary.actor_display_name} · 生效于 {compactTimeLabel(selectedSummary.applied_at)}
                      </p>
                      <p className="inventory-maintenance-revert-copy" aria-live="polite">
                        {selectedSummary.status === 'reverted'
                          ? '这次操作已撤销'
                          : canRevertSelected
                            ? `可在 ${compactTimeLabel(selectedSummary.revertible_until)} 前撤销整次操作`
                            : '撤销窗口已过或当前无权撤销'}
                      </p>
                      {confirmingOperationId === selectedId ? (
                        <p className="inventory-operation-history-confirm subtle" role="status">
                          撤销会回退这次操作涉及的全部变更，请再次点击确认。
                        </p>
                      ) : null}
                    </div>

                    {detail?.lines?.length ? (
                      <ul className="inventory-maintenance-summary-list" aria-label="变更明细">
                        {detail.lines
                          .slice()
                          .sort((left, right) => left.sequence - right.sequence)
                          .map((line) => (
                            <li key={`${line.sequence}:${line.entity_type}:${line.title}`}>
                              <strong>
                                {changeTypeLabel(line.change_type)} · {line.title}
                              </strong>
                              <span>{line.description}</span>
                            </li>
                          ))}
                      </ul>
                    ) : selectedId && !props.detailLoading && !props.detailError ? (
                      <p className="subtle">这次操作没有可展示的明细行。</p>
                    ) : null}
                  </div>
                ) : null}
              </section>
            </div>
          ) : null}
        </div>
      </WorkspaceModal>
    </WorkspaceOverlayFrame>
  );
}
