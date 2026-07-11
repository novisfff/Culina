import { useEffect, useMemo, useState } from 'react';
import type { InventoryOperationResult } from '../../api/types';
import { ActionButton } from '../../components/ui-kit';
import { formatDateTime } from '../../lib/ui';

export type InventoryOperationBannerProps = {
  operation: InventoryOperationResult | null;
  now?: () => number;
  onView?: (operationId: string) => void;
  onRevert?: (operationId: string) => void;
  onOpenHistory?: () => void;
  busy?: boolean;
  className?: string;
};

function compactTimeLabel(iso: string) {
  try {
    return formatDateTime(iso);
  } catch {
    return iso;
  }
}

function formatCountdown(ms: number) {
  if (ms <= 0) return '0:00';
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

export function isOperationStillRevertible(
  operation: InventoryOperationResult | null | undefined,
  nowMs: number,
): boolean {
  if (!operation) return false;
  if (operation.status !== 'applied') return false;
  if (!operation.can_revert) return false;
  const until = Date.parse(operation.revertible_until);
  if (Number.isNaN(until)) return false;
  return until > nowMs;
}

export function selectRecentBannerOperation(
  operations: InventoryOperationResult[],
  nowMs: number,
): InventoryOperationResult | null {
  const eligible = operations
    .filter((operation) => isOperationStillRevertible(operation, nowMs))
    .sort((left, right) => Date.parse(right.applied_at) - Date.parse(left.applied_at));
  return eligible[0] ?? null;
}

export function operationTypeLabel(operationType: InventoryOperationResult['operation_type']) {
  return operationType === 'shopping_intake' ? '本次购买已登记' : '本次盘点已完成';
}

export function InventoryOperationBanner(props: InventoryOperationBannerProps) {
  const nowFn = props.now ?? Date.now;
  const [nowMs, setNowMs] = useState(() => nowFn());

  useEffect(() => {
    setNowMs(nowFn());
    const timer = window.setInterval(() => {
      setNowMs(nowFn());
    }, 1000);
    return () => window.clearInterval(timer);
  }, [nowFn, props.operation?.operation_id, props.operation?.revertible_until, props.operation?.status]);

  const operation = props.operation;
  const remainingMs = useMemo(() => {
    if (!operation) return 0;
    const until = Date.parse(operation.revertible_until);
    if (Number.isNaN(until)) return 0;
    return Math.max(0, until - nowMs);
  }, [nowMs, operation]);

  if (!operation) {
    return null;
  }

  const canRevert = isOperationStillRevertible(operation, nowMs);
  const title = operation.summary.title || operationTypeLabel(operation.operation_type);
  const statusCopy =
    operation.status === 'reverted'
      ? '已撤销'
      : canRevert
        ? `可在 ${compactTimeLabel(operation.revertible_until)} 前撤销`
        : '撤销窗口已过';

  return (
    <section
      className={['inventory-operation-banner', props.className].filter(Boolean).join(' ')}
      aria-label="最近库存操作"
      data-operation-id={operation.operation_id}
    >
      <div className="inventory-operation-banner-copy">
        <p className="eyebrow">最近操作</p>
        <strong>
          {title}
          {canRevert ? ` · ${statusCopy}` : ` · ${statusCopy}`}
        </strong>
        <p className="subtle" aria-live="polite">
          {canRevert
            ? `剩余 ${formatCountdown(remainingMs)} · 撤销将回退整次操作`
            : operation.summary.description || '可在操作历史中查看详情'}
        </p>
      </div>
      <div className="inventory-operation-banner-actions">
        {props.onView || props.onOpenHistory ? (
          <ActionButton
            tone="secondary"
            size="compact"
            type="button"
            disabled={Boolean(props.busy)}
            onClick={() => {
              if (props.onView) {
                props.onView(operation.operation_id);
                return;
              }
              props.onOpenHistory?.();
            }}
          >
            查看
          </ActionButton>
        ) : null}
        {canRevert && props.onRevert ? (
          <ActionButton
            tone="primary"
            size="compact"
            type="button"
            disabled={Boolean(props.busy)}
            onClick={() => props.onRevert?.(operation.operation_id)}
          >
            撤销本次操作
          </ActionButton>
        ) : null}
      </div>
    </section>
  );
}
