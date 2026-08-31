import type { InventoryOperationResult } from '../../api/types/inventory';
import { ActionButton } from '../../components/ui-kit';
import { formatDateTime } from '../../lib/ui';
import { isOperationStillRevertible } from './InventoryOperationBanner';

function compactTimeLabel(iso: string) {
  try { return formatDateTime(iso); } catch { return iso; }
}

export function InventoryReconciliationResultStep(props: {
  result: InventoryOperationResult;
  busy?: boolean;
  onRevertResult?: (operationId: string) => void;
  onViewResult?: (operationId: string) => void;
}) {
  const canRevert = isOperationStillRevertible(props.result, Date.now());
  const applied = props.result.status === 'applied';
  return (
    <section className="inventory-maintenance-result inventory-reconciliation-result" aria-label="盘点结果">
      <div className={['inventory-reconciliation-result-head', applied ? 'is-applied' : 'is-reverted'].join(' ')}>
        <span className="inventory-reconciliation-result-mark" aria-hidden="true">✓</span>
        <div><span>{applied ? '盘点已完成' : '盘点已撤销'}</span><strong>{applied ? '家庭库存已经更新' : '库存已经恢复到变更前'}</strong><p>{props.result.summary.description}</p></div>
      </div>
      <div className="inventory-reconciliation-result-metrics" aria-label="盘点统计">
        <article className="inventory-reconciliation-result-metric"><span>确认</span><strong>{props.result.summary.confirmed_count}</strong><em>项</em></article>
        <article className="inventory-reconciliation-result-metric"><span>调整</span><strong>{props.result.summary.adjusted_count}</strong><em>项</em></article>
        <article className="inventory-reconciliation-result-metric is-status"><span>状态</span><strong>{applied ? '已完成' : '已撤销'}</strong></article>
      </div>
      <p className="inventory-reconciliation-result-notice" aria-live="polite">
        {props.result.status === 'reverted' ? '这次盘点已撤销' : canRevert ? `可在 ${compactTimeLabel(props.result.revertible_until)} 前撤销本次盘点` : '已超过可撤销时间，或你没有撤销权限'}
      </p>
      {(props.onViewResult || (canRevert && props.onRevertResult)) ? <div className="inventory-operation-result-actions inventory-reconciliation-result-actions">
        {props.onViewResult ? <ActionButton tone="secondary" size="compact" type="button" disabled={Boolean(props.busy)} onClick={() => props.onViewResult?.(props.result.operation_id)}>查看详情</ActionButton> : null}
        {canRevert && props.onRevertResult ? <ActionButton tone="secondary" size="compact" type="button" className="inventory-reconciliation-result-revert" disabled={Boolean(props.busy)} onClick={() => props.onRevertResult?.(props.result.operation_id)}>撤销本次盘点</ActionButton> : null}
      </div> : null}
    </section>
  );
}
