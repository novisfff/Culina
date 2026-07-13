import { useEffect, useMemo, type ReactNode } from 'react';
import type {
  InventoryAvailabilityLevel,
  InventoryOperationResult,
  InventoryReconciliationGroup,
  InventoryStatus,
} from '../../api/types';
import {
  ActionButton,
  FormActions,
  MobileActionBar,
  OptionChipGroup,
  QuantityUnitField,
  StateBlock,
  WorkspaceModal,
  WorkspaceOverlayFrame,
} from '../../components/ui-kit';
import { formatDateTime } from '../../lib/ui';
import { isOperationStillRevertible } from './InventoryOperationBanner';
import {
  AVAILABILITY_LEVEL_LABELS,
  buildBatchCreateIntent,
  buildBatchUpdateFromGroup,
  buildExactAdjustBatchesIntent,
  buildExactConfirmAllIntent,
  buildExactSetAbsentIntent,
  buildFoodConfirmIntent,
  buildFoodSetAbsentIntent,
  buildFoodSetStockIntent,
  buildGroupHeadline,
  buildPresenceIntent,
  findIntent,
  formatSubmitSummaryLines,
  isPhysicalBatchExpired,
  reconciliationGroupTargetKey,
  SCOPE_LABELS,
  scopeLabel,
  storageLocationForScope,
  type ExactBatchCreateIntent,
  type ExactBatchUpdateIntent,
  type ExactIngredientIntent,
  type FoodIntent,
  type InventoryReconciliationDraft,
  type InventoryReconciliationScope,
  type InventoryReconciliationStep,
  type PresenceIngredientIntent,
  type ReconciliationConflictState,
  type ReconciliationFieldError,
  type ReconciliationIntent,
  type ReconciliationSubmitSummary,
} from './inventoryReconciliationModel';

export type InventoryReconciliationDialogProps = {
  open: boolean;
  step: InventoryReconciliationStep;
  scope: InventoryReconciliationScope;
  draft: InventoryReconciliationDraft | null;
  groups: InventoryReconciliationGroup[];
  orderedGroups: InventoryReconciliationGroup[];
  referenceDate: string;
  loading?: boolean;
  busy?: boolean;
  errorMessage?: string | null;
  fieldErrors?: ReconciliationFieldError[];
  focusFieldKey?: string | null;
  conflictState?: ReconciliationConflictState;
  result?: InventoryOperationResult | null;
  summary?: ReconciliationSubmitSummary;
  checkedCount?: number;
  totalCount?: number;
  canSubmit?: boolean;
  expandedBatchGroupKeys?: string[];
  overlayRootClassName?: string;
  onClose: () => void;
  onChangeScope: (scope: InventoryReconciliationScope) => void;
  onToggleBatchDetails: (groupKey: string) => void;
  onSetIntent: (intent: ReconciliationIntent) => void;
  onClearIntent: (targetKey: string) => void;
  onGoSummary: () => void;
  onGoReview: () => void;
  onSubmit: () => void;
  onRetry?: () => void;
  onRevertResult?: (operationId: string) => void;
  onViewResult?: (operationId: string) => void;
};

const SCOPE_OPTIONS: InventoryReconciliationScope[] = [
  'suggested',
  'refrigerated',
  'frozen',
  'room_temperature',
  'all',
];

const PRESENCE_OPTIONS: Array<{ value: InventoryAvailabilityLevel; label: string }> = [
  { value: 'present_unknown', label: AVAILABILITY_LEVEL_LABELS.present_unknown },
  { value: 'low', label: AVAILABILITY_LEVEL_LABELS.low },
  { value: 'sufficient', label: AVAILABILITY_LEVEL_LABELS.sufficient },
  { value: 'absent', label: AVAILABILITY_LEVEL_LABELS.absent },
];

function compactTimeLabel(iso: string) {
  try {
    return formatDateTime(iso);
  } catch {
    return iso;
  }
}

function fieldErrorFor(
  fieldErrors: ReconciliationFieldError[] | undefined,
  targetKey: string,
  field?: string,
) {
  if (!fieldErrors?.length) return null;
  return (
    fieldErrors.find(
      (error) =>
        error.targetKey === targetKey &&
        (field ? error.field === field || error.field.includes(field) : true),
    ) ?? null
  );
}

function fieldErrorsFor(
  fieldErrors: ReconciliationFieldError[] | undefined,
  targetKey: string,
  fields: string[],
): ReconciliationFieldError[] {
  return fields.flatMap((field) => {
    const error = fieldErrorFor(fieldErrors, targetKey, field);
    return error ? [error] : [];
  });
}

function intentActionLabel(intent: ReconciliationIntent | null): string | null {
  if (!intent) return null;
  if (intent.kind === 'exact_ingredient') {
    if (intent.action === 'confirm_all') return '确认无误';
    if (intent.action === 'set_absent') return '没有了';
    return '调整数量';
  }
  if (intent.kind === 'presence_ingredient') {
    return AVAILABILITY_LEVEL_LABELS[intent.availabilityLevel];
  }
  if (intent.action === 'confirm') return '确认无误';
  if (intent.stockQuantity === '0') return '没有了';
  return '调整数量';
}

export function InventoryReconciliationDialog(props: InventoryReconciliationDialogProps) {
  const busy = Boolean(props.busy);
  const loading = Boolean(props.loading);
  const fieldErrors = props.fieldErrors ?? [];
  const expanded = new Set(props.expandedBatchGroupKeys ?? []);
  const checkedCount = props.checkedCount ?? props.draft?.intents.length ?? 0;
  const totalCount = props.totalCount ?? props.groups.length;
  const summary = props.summary ?? {
    confirmCount: 0,
    adjustedCount: 0,
    lowCount: 0,
    absentCount: 0,
    createdBatchCount: 0,
    totalTouched: 0,
  };

  useEffect(() => {
    if (!props.open || !props.focusFieldKey) return;
    const node = document.querySelector<HTMLElement>(`[data-field-key="${props.focusFieldKey}"]`);
    if (node && typeof node.focus === 'function' && node.getAttribute('type') !== 'hidden') {
      node.focus();
    }
  }, [props.open, props.focusFieldKey, fieldErrors, props.step]);

  if (!props.open) {
    return null;
  }

  const closeIfAllowed = () => {
    if (!busy) {
      props.onClose();
    }
  };

  const title =
    props.step === 'result'
      ? '本次盘点已完成'
      : props.step === 'summary'
        ? '确认提交摘要'
        : '快速盘点';

  const description =
    props.step === 'result'
      ? props.result?.summary.description || '库存确认已同步更新。'
      : props.step === 'summary'
        ? '只提交你确认或调整过的项目；未触碰项保持原状。'
        : `${scopeLabel(props.scope)}范围 · 逐项核对当前库存，未操作的项目不会被修改。`;

  const remainingErrorCount = fieldErrors.length;
  const canRevertResult = isOperationStillRevertible(props.result, Date.now());
  const liveMessage =
    props.errorMessage ||
    (remainingErrorCount > 0 ? `还有 ${remainingErrorCount} 处需要确认` : null) ||
    (props.step === 'result' && props.result
      ? canRevertResult
        ? `可在 ${compactTimeLabel(props.result.revertible_until)} 前撤销`
        : props.result.status === 'reverted'
          ? '这次操作已撤销'
          : '撤销窗口已过或当前无权撤销'
      : `已检查 ${checkedCount} / ${totalCount}`);

  let footerActions: ReactNode = null;
  if (props.step === 'review') {
    footerActions = (
      <FormActions
        className="inventory-maintenance-actions"
        primaryLabel={`查看摘要（${checkedCount}）`}
        isSubmitting={busy}
        primaryDisabled={busy || loading || checkedCount === 0}
        onPrimary={props.onGoSummary}
        secondaryLabel="关闭"
        onSecondary={closeIfAllowed}
      />
    );
  } else if (props.step === 'summary') {
    footerActions = (
      <FormActions
        className="inventory-maintenance-actions"
        primaryLabel={busy ? '提交中…' : '确认提交盘点'}
        isSubmitting={busy}
        primaryDisabled={busy || loading || !props.canSubmit}
        onPrimary={props.onSubmit}
        secondaryLabel="返回检查"
        onSecondary={() => {
          if (!busy) props.onGoReview();
        }}
      />
    );
  } else {
    footerActions = (
      <FormActions
        className="inventory-maintenance-actions"
        primaryLabel="完成"
        isSubmitting={false}
        onPrimary={closeIfAllowed}
        secondaryLabel={
          canRevertResult && props.onRevertResult
            ? '撤销本次操作'
            : canRevertResult
              ? '稍后可撤销'
              : undefined
        }
        onSecondary={
          canRevertResult && props.onRevertResult
            ? () => props.onRevertResult?.(props.result!.operation_id)
            : canRevertResult
              ? closeIfAllowed
              : undefined
        }
      />
    );
  }

  const footerInfo = (
    <div className="inventory-maintenance-footer-summary">
      {props.step === 'result' && props.result ? (
        <>
          <span>已完成</span>
          <strong>
            确认 {props.result.summary.confirmed_count} · 调整 {props.result.summary.adjusted_count}
          </strong>
          <p>
            {canRevertResult
              ? `可在 ${compactTimeLabel(props.result.revertible_until)} 前撤销`
              : props.result.status === 'reverted'
                ? '这次操作已撤销'
                : '撤销窗口已过或当前无权撤销'}
          </p>
        </>
      ) : (
        <>
          <span>已检查</span>
          <strong>
            {checkedCount}/{totalCount}
          </strong>
        </>
      )}
    </div>
  );

  return (
    <WorkspaceOverlayFrame
      rootClassName={['inventory-maintenance-overlay-root', props.overlayRootClassName]
        .filter(Boolean)
        .join(' ')}
      closeOnBackdrop={!busy}
      busy={busy}
      labelledBy="inventory-reconciliation-title"
      onClose={closeIfAllowed}
    >
      <WorkspaceModal
        title={title}
        titleId="inventory-reconciliation-title"
        description={description}
        eyebrow="快速盘点"
        closeLabel="关闭"
        closeAriaLabel="关闭快速盘点"
        className="workspace-modal-wide inventory-maintenance-modal inventory-reconciliation-modal"
        onClose={closeIfAllowed}
        busy={busy}
        footerInfo={footerInfo}
        footerActions={
          <>
            <div className="inventory-maintenance-desktop-actions">{footerActions}</div>
            <MobileActionBar className="inventory-maintenance-mobile-actions">{footerActions}</MobileActionBar>
          </>
        }
      >
        <div className="inventory-maintenance-scroll inventory-reconciliation-scroll">
          <div className="inventory-maintenance-live" aria-live="polite">
            {liveMessage}
          </div>

          {props.step !== 'result' ? (
            <section className="inventory-maintenance-section inventory-reconciliation-scope" aria-label="盘点范围">
              <div className="inventory-maintenance-section-head">
                <span>盘点范围</span>
                <em>
                  {checkedCount}/{totalCount} 已检查
                </em>
              </div>
              <OptionChipGroup
                ariaLabel="盘点范围"
                value={props.scope}
                size="large"
                className="inventory-maintenance-chip-group"
                onChange={(value) => {
                  if (busy || loading) return;
                  props.onChangeScope(value as InventoryReconciliationScope);
                }}
                options={SCOPE_OPTIONS.map((scope) => ({
                  value: scope,
                  label: SCOPE_LABELS[scope],
                }))}
              />
              <div className="inventory-reconciliation-progress" aria-live="polite">
                <progress value={checkedCount} max={Math.max(totalCount, 1)} aria-label={`盘点进度 ${checkedCount} / ${totalCount}`} />
                <span>进度 {checkedCount} / {totalCount}</span>
              </div>
            </section>
          ) : null}

          {props.conflictState && props.conflictState !== 'none' ? (
            <div className="inventory-maintenance-conflict" role="status">
              <strong>需要重新确认</strong>
              <p>{props.errorMessage ?? '家人可能刚改动了库存，请刷新后重新确认。'}</p>
              {props.onRetry ? (
                <ActionButton tone="secondary" size="compact" type="button" disabled={busy} onClick={props.onRetry}>
                  重试提交
                </ActionButton>
              ) : null}
            </div>
          ) : null}

          {props.errorMessage && (!props.conflictState || props.conflictState === 'none') ? (
            <div className="inventory-maintenance-error" role="alert">
              {props.errorMessage}
              {remainingErrorCount > 1 ? `（剩余 ${remainingErrorCount} 处）` : null}
            </div>
          ) : null}

          {loading ? (
            <StateBlock
              status="loading"
              title="正在准备盘点清单"
              description="稍等一下，正在读取当前库存。"
              className="inventory-maintenance-state"
            />
          ) : null}

          {!loading && props.step !== 'result' && props.groups.length === 0 ? (
            <StateBlock
              status="empty"
              title="这个范围没有需要盘点的项目"
              description="可以换一个范围，或稍后再来。"
              className="inventory-maintenance-state"
            />
          ) : null}

          {!loading && props.step === 'review' && props.draft ? (
            <ReviewLayout
              draft={props.draft}
              orderedGroups={props.orderedGroups}
              referenceDate={props.referenceDate}
              busy={busy}
              fieldErrors={fieldErrors}
              expanded={expanded}
              summary={summary}
              onToggleBatchDetails={props.onToggleBatchDetails}
              onSetIntent={props.onSetIntent}
              onClearIntent={props.onClearIntent}
            />
          ) : null}

          {!loading && props.step === 'summary' && props.draft ? (
            <SummaryStep summary={summary} draft={props.draft} groups={props.groups} />
          ) : null}

          {!loading && props.step === 'result' && props.result ? (
            <ResultStep
              result={props.result}
              busy={busy}
              onRevertResult={props.onRevertResult}
              onViewResult={props.onViewResult}
            />
          ) : null}
        </div>
      </WorkspaceModal>
    </WorkspaceOverlayFrame>
  );
}

function ReviewLayout(props: {
  draft: InventoryReconciliationDraft;
  orderedGroups: InventoryReconciliationGroup[];
  referenceDate: string;
  busy: boolean;
  fieldErrors: ReconciliationFieldError[];
  expanded: Set<string>;
  summary: ReconciliationSubmitSummary;
  onToggleBatchDetails: (groupKey: string) => void;
  onSetIntent: (intent: ReconciliationIntent) => void;
  onClearIntent: (targetKey: string) => void;
}) {
  const summaryLines = formatSubmitSummaryLines(props.summary);
  return (
    <div className="inventory-reconciliation-layout">
      <section className="inventory-maintenance-section inventory-reconciliation-list" aria-label="库存清单">
        <div className="inventory-maintenance-section-head">
          <span>库存卡片</span>
          <em>{props.orderedGroups.length} 项</em>
        </div>
        <div className="inventory-maintenance-item-list">
          {props.orderedGroups.map((group) => {
            const targetKey = reconciliationGroupTargetKey(group);
            const intent = findIntent(props.draft, targetKey);
            return (
              <GroupCard
                key={targetKey}
                group={group}
                intent={intent}
                referenceDate={props.referenceDate}
                busy={props.busy}
                fieldErrors={props.fieldErrors}
                expanded={props.expanded.has(targetKey)}
                onToggleBatchDetails={() => props.onToggleBatchDetails(targetKey)}
                onSetIntent={props.onSetIntent}
                onClearIntent={() => props.onClearIntent(targetKey)}
              />
            );
          })}
        </div>
      </section>

      <aside className="inventory-maintenance-section inventory-reconciliation-side-summary" aria-label="本次摘要">
        <div className="inventory-maintenance-section-head">
          <span>本次摘要</span>
          <em>{props.summary.totalTouched} 项</em>
        </div>
        {summaryLines.length === 0 ? (
          <div className="inventory-reconciliation-summary-empty">
            <span className="inventory-reconciliation-summary-icon" aria-hidden="true">✓</span>
            <strong>从左侧开始确认</strong>
            <p className="subtle">确认、调整或清空库存后，本次变更会汇总在这里。</p>
            <span className="inventory-reconciliation-summary-remaining">
              待检查 {props.orderedGroups.length} 项
            </span>
          </div>
        ) : (
          <ul className="inventory-maintenance-summary-list">
            {summaryLines.map((line) => (
              <li key={line.label}>
                <strong>{line.label}</strong>
                <span>{line.count} 项</span>
              </li>
            ))}
          </ul>
        )}
      </aside>
    </div>
  );
}

function GroupCard(props: {
  group: InventoryReconciliationGroup;
  intent: ReconciliationIntent | null;
  referenceDate: string;
  busy: boolean;
  fieldErrors: ReconciliationFieldError[];
  expanded: boolean;
  onToggleBatchDetails: () => void;
  onSetIntent: (intent: ReconciliationIntent) => void;
  onClearIntent: () => void;
}) {
  const targetKey = reconciliationGroupTargetKey(props.group);
  const headline = buildGroupHeadline(props.group, props.referenceDate);
  const actionLabel = intentActionLabel(props.intent);
  const error = fieldErrorFor(props.fieldErrors, targetKey);

  return (
    <article
      className={[
        'inventory-maintenance-item-card',
        'inventory-reconciliation-group-card',
        props.intent ? 'is-selected' : '',
        error ? 'has-error' : '',
        headline.hasExpiredPhysicalBatch ? 'has-expired' : '',
      ]
        .filter(Boolean)
        .join(' ')}
      data-group-key={targetKey}
    >
      <div className="inventory-maintenance-item-copy">
        <div className="inventory-maintenance-item-title-row">
          <strong>{headline.title}</strong>
          <span
            className={`inventory-maintenance-chip is-confirmation is-${props.group.confirmation_status === 'current' ? 'current' : props.group.confirmation_status === 'stale' ? 'stale' : 'neutral'}`}
          >
            {headline.confirmationLabel}
          </span>
          {actionLabel ? <span className="inventory-maintenance-chip is-action">{actionLabel}</span> : null}
          {headline.hasExpiredPhysicalBatch ? (
            <span className="inventory-maintenance-chip is-warning">含过期批次</span>
          ) : null}
        </div>
        <p className="subtle">{headline.detail}</p>
      </div>

      {props.group.kind === 'exact_ingredient' ? (
        <ExactGroupActions
          group={props.group}
          intent={props.intent?.kind === 'exact_ingredient' ? props.intent : null}
          referenceDate={props.referenceDate}
          busy={props.busy}
          expanded={props.expanded}
          fieldErrors={props.fieldErrors}
          onToggleBatchDetails={props.onToggleBatchDetails}
          onSetIntent={props.onSetIntent}
          onClearIntent={props.onClearIntent}
        />
      ) : null}

      {props.group.kind === 'presence_ingredient' ? (
        <PresenceGroupActions
          group={props.group}
          intent={props.intent?.kind === 'presence_ingredient' ? props.intent : null}
          busy={props.busy}
          fieldErrors={props.fieldErrors}
          onSetIntent={props.onSetIntent}
          onClearIntent={props.onClearIntent}
        />
      ) : null}

      {props.group.kind === 'food' ? (
        <FoodGroupActions
          group={props.group}
          intent={props.intent?.kind === 'food' ? props.intent : null}
          busy={props.busy}
          fieldErrors={props.fieldErrors}
          onSetIntent={props.onSetIntent}
          onClearIntent={props.onClearIntent}
        />
      ) : null}

      {error ? <p className="inventory-maintenance-field-error">{error.message}</p> : null}
    </article>
  );
}

function ExactGroupActions(props: {
  group: Extract<InventoryReconciliationGroup, { kind: 'exact_ingredient' }>;
  intent: ExactIngredientIntent | null;
  referenceDate: string;
  busy: boolean;
  expanded: boolean;
  fieldErrors: ReconciliationFieldError[];
  onToggleBatchDetails: () => void;
  onSetIntent: (intent: ReconciliationIntent) => void;
  onClearIntent: () => void;
}) {
  const targetKey = reconciliationGroupTargetKey(props.group);
  const showBatches = props.expanded || props.intent?.action === 'adjust_batches';

  return (
    <div className="inventory-reconciliation-group-actions">
      <div className="inventory-reconciliation-action-row">
        <ActionButton
          tone={props.intent?.action === 'confirm_all' ? 'primary' : 'secondary'}
          size="compact"
          type="button"
          disabled={props.busy}
          data-field-key={`${targetKey}:confirm_all`}
          onClick={() => props.onSetIntent(buildExactConfirmAllIntent(props.group))}
        >
          确认无误
        </ActionButton>
        <ActionButton
          tone={props.intent?.action === 'adjust_batches' ? 'primary' : 'secondary'}
          size="compact"
          type="button"
          disabled={props.busy}
          data-field-key={`${targetKey}:adjust_batches`}
          onClick={() => {
            const updates = props.group.batches
              .filter((batch) => batch.remaining_quantity > 0)
              .map((batch) => buildBatchUpdateFromGroup(props.group, batch.inventory_item_id)!)
              .filter(Boolean);
            props.onSetIntent(
              buildExactAdjustBatchesIntent({
                group: props.group,
                updates,
                creates: props.intent?.creates ?? [],
              }),
            );
            if (!props.expanded) {
              props.onToggleBatchDetails();
            }
          }}
        >
          调整数量
        </ActionButton>
        <ActionButton
          tone={props.intent?.action === 'set_absent' ? 'primary' : 'secondary'}
          size="compact"
          type="button"
          disabled={props.busy}
          data-field-key={`${targetKey}:set_absent`}
          onClick={() => props.onSetIntent(buildExactSetAbsentIntent(props.group))}
        >
          没有了
        </ActionButton>
        {props.intent ? (
          <ActionButton tone="tertiary" size="compact" type="button" disabled={props.busy} onClick={props.onClearIntent}>
            取消
          </ActionButton>
        ) : null}
        <ActionButton
          tone="tertiary"
          size="compact"
          type="button"
          disabled={props.busy}
          onClick={props.onToggleBatchDetails}
        >
          {showBatches ? '收起批次' : '展开批次'}
        </ActionButton>
      </div>

      {showBatches ? (
        <ExactBatchEditor
          group={props.group}
          intent={props.intent}
          referenceDate={props.referenceDate}
          busy={props.busy}
          fieldErrors={props.fieldErrors}
          onSetIntent={props.onSetIntent}
        />
      ) : null}
    </div>
  );
}

function ExactBatchEditor(props: {
  group: Extract<InventoryReconciliationGroup, { kind: 'exact_ingredient' }>;
  intent: ExactIngredientIntent | null;
  referenceDate: string;
  busy: boolean;
  fieldErrors: ReconciliationFieldError[];
  onSetIntent: (intent: ReconciliationIntent) => void;
}) {
  const targetKey = reconciliationGroupTargetKey(props.group);
  const updates =
    props.intent?.action === 'adjust_batches'
      ? props.intent.updates
      : props.group.batches
          .filter((batch) => batch.remaining_quantity > 0)
          .map((batch) => buildBatchUpdateFromGroup(props.group, batch.inventory_item_id)!)
          .filter(Boolean);
  const creates = props.intent?.creates ?? [];

  const ensureAdjustIntent = (
    nextUpdates: ExactBatchUpdateIntent[],
    nextCreates: ExactBatchCreateIntent[],
  ) => {
    props.onSetIntent(
      buildExactAdjustBatchesIntent({
        group: props.group,
        updates: nextUpdates,
        creates: nextCreates,
      }),
    );
  };

  return (
    <div className="inventory-reconciliation-batch-list" aria-label={`${props.group.ingredient_name} 批次`}>
      {props.group.batches
        .filter((batch) => batch.remaining_quantity > 0)
        .map((batch) => {
          const update =
            updates.find((entry) => entry.inventoryItemId === batch.inventory_item_id) ??
            buildBatchUpdateFromGroup(props.group, batch.inventory_item_id)!;
          const batchErrors = fieldErrorsFor(props.fieldErrors, targetKey, [
            `batch:${batch.inventory_item_id}:actualRemainingQuantity`,
            `batch:${batch.inventory_item_id}:purchaseDate`,
            `batch:${batch.inventory_item_id}:expiryDate`,
            `batch:${batch.inventory_item_id}:storageLocation`,
          ]);
          const expired = isPhysicalBatchExpired(batch, props.referenceDate);
          return (
            <div
              key={batch.inventory_item_id}
              className={['inventory-reconciliation-batch-row', expired ? 'is-expired' : '']
                .filter(Boolean)
                .join(' ')}
            >
              <div className="inventory-maintenance-item-title-row">
                <strong>
                  {batch.storage_location || '未设位置'} · 记录 {batch.remaining_quantity}
                  {batch.unit}
                </strong>
                {expired ? <span className="inventory-maintenance-chip is-warning">已过期</span> : null}
              </div>
              <QuantityUnitField
                quantity={update.actualRemainingQuantity}
                unit={batch.unit}
                unitOptions={[{ value: batch.unit, label: batch.unit || '单位' }]}
                quantityDisabled={props.busy}
                quantityFieldKey={`${targetKey}:batch:${batch.inventory_item_id}:actualRemainingQuantity`}
                onQuantityChange={(value) => {
                  const nextUpdates = updates.map((entry) =>
                    entry.inventoryItemId === batch.inventory_item_id
                      ? { ...entry, actualRemainingQuantity: value }
                      : entry,
                  );
                  if (!nextUpdates.some((entry) => entry.inventoryItemId === batch.inventory_item_id)) {
                    nextUpdates.push({ ...update, actualRemainingQuantity: value });
                  }
                  ensureAdjustIntent(nextUpdates, creates);
                }}
                onUnitChange={() => undefined}
                className="inventory-maintenance-quantity"
              />
              <div className="inventory-reconciliation-batch-fields">
                <label className="inventory-maintenance-date-field">
                  <span>购买日期</span>
                  <input
                    type="date"
                    value={update.purchaseDate}
                    disabled={props.busy}
                    data-field-key={`${targetKey}:batch:${batch.inventory_item_id}:purchaseDate`}
                    onChange={(event) => {
                      ensureAdjustIntent(
                        updates.map((entry) =>
                          entry.inventoryItemId === batch.inventory_item_id
                            ? { ...entry, purchaseDate: event.target.value }
                            : entry,
                        ),
                        creates,
                      );
                    }}
                  />
                </label>
                <label className="inventory-maintenance-date-field">
                  <span>到期日</span>
                  <input
                    type="date"
                    value={update.expiryDate ?? ''}
                    disabled={props.busy}
                    data-field-key={`${targetKey}:batch:${batch.inventory_item_id}:expiryDate`}
                    onChange={(event) => {
                      ensureAdjustIntent(
                        updates.map((entry) =>
                          entry.inventoryItemId === batch.inventory_item_id
                            ? { ...entry, expiryDate: event.target.value || null }
                            : entry,
                        ),
                        creates,
                      );
                    }}
                  />
                </label>
                <label className="inventory-maintenance-date-field">
                  <span>存放位置</span>
                  <input
                    type="text"
                    value={update.storageLocation}
                    disabled={props.busy}
                    data-field-key={`${targetKey}:batch:${batch.inventory_item_id}:storageLocation`}
                    onChange={(event) => {
                      ensureAdjustIntent(
                        updates.map((entry) =>
                          entry.inventoryItemId === batch.inventory_item_id
                            ? { ...entry, storageLocation: event.target.value }
                            : entry,
                        ),
                        creates,
                      );
                    }}
                  />
                </label>
              </div>
              {batchErrors.map((error) => (
                <p key={error.field} className="inventory-maintenance-field-error">
                  {error.message}
                </p>
              ))}
            </div>
          );
        })}

      {creates.map((create) => {
        const createErrors = fieldErrorsFor(props.fieldErrors, targetKey, [
          `create:${create.clientLineId}:actualRemainingQuantity`,
          `create:${create.clientLineId}:unit`,
          `create:${create.clientLineId}:purchaseDate`,
          `create:${create.clientLineId}:expiryDate`,
          `create:${create.clientLineId}:storageLocation`,
        ]);
        return (
        <div key={create.clientLineId} className="inventory-reconciliation-batch-row is-create">
          <div className="inventory-maintenance-item-title-row">
            <strong>新增漏记批次</strong>
          </div>
          <QuantityUnitField
            quantity={create.actualRemainingQuantity}
            unit={create.unit}
            unitOptions={[{ value: create.unit, label: create.unit || '单位' }]}
            quantityDisabled={props.busy}
            quantityFieldKey={`${targetKey}:create:${create.clientLineId}:actualRemainingQuantity`}
            unitFieldKey={`${targetKey}:create:${create.clientLineId}:unit`}
            onQuantityChange={(value) => {
              ensureAdjustIntent(
                updates,
                creates.map((entry) =>
                  entry.clientLineId === create.clientLineId
                    ? { ...entry, actualRemainingQuantity: value }
                    : entry,
                ),
              );
            }}
            onUnitChange={(value) => {
              ensureAdjustIntent(
                updates,
                creates.map((entry) =>
                  entry.clientLineId === create.clientLineId ? { ...entry, unit: value } : entry,
                ),
              );
            }}
            className="inventory-maintenance-quantity"
          />
          <div className="inventory-reconciliation-batch-fields">
            <label className="inventory-maintenance-date-field">
              <span>购买日期</span>
              <input
                type="date"
                value={create.purchaseDate}
                disabled={props.busy}
                data-field-key={`${targetKey}:create:${create.clientLineId}:purchaseDate`}
                onChange={(event) => {
                  ensureAdjustIntent(
                    updates,
                    creates.map((entry) =>
                      entry.clientLineId === create.clientLineId
                        ? { ...entry, purchaseDate: event.target.value }
                        : entry,
                    ),
                  );
                }}
              />
            </label>
            <label className="inventory-maintenance-date-field">
              <span>到期日</span>
              <input
                type="date"
                value={create.expiryDate ?? ''}
                disabled={props.busy}
                data-field-key={`${targetKey}:create:${create.clientLineId}:expiryDate`}
                onChange={(event) => {
                  ensureAdjustIntent(
                    updates,
                    creates.map((entry) =>
                      entry.clientLineId === create.clientLineId
                        ? { ...entry, expiryDate: event.target.value || null }
                        : entry,
                    ),
                  );
                }}
              />
            </label>
            <label className="inventory-maintenance-date-field">
              <span>存放位置</span>
              <input
                type="text"
                value={create.storageLocation}
                disabled={props.busy}
                data-field-key={`${targetKey}:create:${create.clientLineId}:storageLocation`}
                onChange={(event) => {
                  ensureAdjustIntent(
                    updates,
                    creates.map((entry) =>
                      entry.clientLineId === create.clientLineId
                        ? { ...entry, storageLocation: event.target.value }
                        : entry,
                    ),
                  );
                }}
              />
            </label>
          </div>
          {createErrors.map((error) => (
            <p key={error.field} className="inventory-maintenance-field-error">
              {error.message}
            </p>
          ))}
          <ActionButton
            tone="tertiary"
            size="compact"
            type="button"
            disabled={props.busy}
            onClick={() =>
              ensureAdjustIntent(
                updates,
                creates.filter((entry) => entry.clientLineId !== create.clientLineId),
              )
            }
          >
            移除新增批次
          </ActionButton>
        </div>
        );
      })}

      <ActionButton
        tone="secondary"
        size="compact"
        type="button"
        disabled={props.busy}
        onClick={() => {
          const defaultUnit = props.group.batches[0]?.unit || '个';
          const defaultLocation =
            props.group.batches[0]?.storage_location ||
            storageLocationForScope('refrigerated') ||
            '冷藏';
          ensureAdjustIntent(updates, [
            ...creates,
            buildBatchCreateIntent({
              actualRemainingQuantity: '1',
              unit: defaultUnit,
              inventoryStatus: 'fresh' as InventoryStatus,
              purchaseDate: props.referenceDate,
              expiryDate: null,
              storageLocation: defaultLocation,
            }),
          ]);
        }}
      >
        增加漏记批次
      </ActionButton>
    </div>
  );
}

function PresenceGroupActions(props: {
  group: Extract<InventoryReconciliationGroup, { kind: 'presence_ingredient' }>;
  intent: PresenceIngredientIntent | null;
  busy: boolean;
  fieldErrors: ReconciliationFieldError[];
  onSetIntent: (intent: ReconciliationIntent) => void;
  onClearIntent: () => void;
}) {
  const targetKey = reconciliationGroupTargetKey(props.group);
  // Unselected until explicit intent — avoid looking "already checked" from current state.
  const selectedLevel = props.intent?.availabilityLevel ?? null;
  const storageError = fieldErrorFor(props.fieldErrors, targetKey, 'storageLocation');

  return (
    <div className="inventory-reconciliation-group-actions">
      <div className="inventory-maintenance-field-head">
        <span>家庭有无</span>
        <p className="subtle">只记录整体状态，不区分多个批次。</p>
      </div>
      <OptionChipGroup
        ariaLabel={`${props.group.ingredient_name} 有无状态`}
        value={(selectedLevel ?? '') as InventoryAvailabilityLevel}
        size="large"
        className="inventory-maintenance-chip-group"
        onChange={(value) => {
          if (props.busy) return;
          props.onSetIntent(
            buildPresenceIntent({
              group: props.group,
              availabilityLevel: value as InventoryAvailabilityLevel,
              inventoryStatus: props.intent?.inventoryStatus,
              purchaseDate: props.intent?.purchaseDate,
              expiryDate: props.intent?.expiryDate,
              storageLocation: props.intent?.storageLocation,
              notes: props.intent?.notes,
            }),
          );
        }}
        options={PRESENCE_OPTIONS}
      />
      {selectedLevel && selectedLevel !== 'absent' ? (
        <div className="inventory-reconciliation-batch-fields">
          <label className="inventory-maintenance-date-field">
            <span>存放位置</span>
            <input
              type="text"
              value={props.intent?.storageLocation ?? props.group.state.storage_location ?? ''}
              disabled={props.busy}
              data-field-key={`${targetKey}:storageLocation`}
              onChange={(event) => {
                props.onSetIntent(
                  buildPresenceIntent({
                    group: props.group,
                    availabilityLevel: selectedLevel,
                    storageLocation: event.target.value,
                    purchaseDate: props.intent?.purchaseDate,
                    expiryDate: props.intent?.expiryDate,
                    notes: props.intent?.notes,
                  }),
                );
              }}
            />
          </label>
          <label className="inventory-maintenance-date-field">
            <span>到期日（可选）</span>
            <input
              type="date"
              value={props.intent?.expiryDate ?? props.group.state.expiry_date ?? ''}
              disabled={props.busy}
              data-field-key={`${targetKey}:expiryDate`}
              onChange={(event) => {
                props.onSetIntent(
                  buildPresenceIntent({
                    group: props.group,
                    availabilityLevel: selectedLevel,
                    expiryDate: event.target.value || null,
                    storageLocation: props.intent?.storageLocation,
                    purchaseDate: props.intent?.purchaseDate,
                    notes: props.intent?.notes,
                  }),
                );
              }}
            />
          </label>
        </div>
      ) : null}
      {props.group.pending_shopping_item_id ? (
        <p className="subtle">已在采购清单</p>
      ) : selectedLevel === 'low' ? (
        <p className="subtle">标记少量后可一键加入采购（不会自动写入）。</p>
      ) : null}
      {storageError ? <p className="inventory-maintenance-field-error">{storageError.message}</p> : null}
      {props.intent ? (
        <ActionButton tone="tertiary" size="compact" type="button" disabled={props.busy} onClick={props.onClearIntent}>
          取消
        </ActionButton>
      ) : null}
    </div>
  );
}

function FoodGroupActions(props: {
  group: Extract<InventoryReconciliationGroup, { kind: 'food' }>;
  intent: FoodIntent | null;
  busy: boolean;
  fieldErrors: ReconciliationFieldError[];
  onSetIntent: (intent: ReconciliationIntent) => void;
  onClearIntent: () => void;
}) {
  const targetKey = reconciliationGroupTargetKey(props.group);
  const adjusting = props.intent?.action === 'set_stock' && props.intent.stockQuantity !== '0';
  const qtyError = fieldErrorFor(props.fieldErrors, targetKey, 'stockQuantity');
  const unitError = fieldErrorFor(props.fieldErrors, targetKey, 'stockUnit');
  const storageError = fieldErrorFor(props.fieldErrors, targetKey, 'storageLocation');

  return (
    <div className="inventory-reconciliation-group-actions">
      <p className="inventory-reconciliation-food-warning" role="note">
        成品是聚合库存：修改数量或位置会影响全部成品库存，不会区分批次。
      </p>
      <div className="inventory-reconciliation-action-row">
        <ActionButton
          tone={props.intent?.action === 'confirm' ? 'primary' : 'secondary'}
          size="compact"
          type="button"
          disabled={props.busy}
          data-field-key={`${targetKey}:confirm`}
          onClick={() => props.onSetIntent(buildFoodConfirmIntent(props.group))}
        >
          确认无误
        </ActionButton>
        <ActionButton
          tone={adjusting ? 'primary' : 'secondary'}
          size="compact"
          type="button"
          disabled={props.busy}
          data-field-key={`${targetKey}:set_stock`}
          onClick={() =>
            props.onSetIntent(
              buildFoodSetStockIntent({
                group: props.group,
                stockQuantity: String(props.group.stock_quantity),
              }),
            )
          }
        >
          调整数量
        </ActionButton>
        <ActionButton
          tone={
            props.intent?.action === 'set_stock' && props.intent.stockQuantity === '0'
              ? 'primary'
              : 'secondary'
          }
          size="compact"
          type="button"
          disabled={props.busy}
          data-field-key={`${targetKey}:set_absent`}
          onClick={() => props.onSetIntent(buildFoodSetAbsentIntent(props.group))}
        >
          没有了
        </ActionButton>
        {props.intent ? (
          <ActionButton tone="tertiary" size="compact" type="button" disabled={props.busy} onClick={props.onClearIntent}>
            取消
          </ActionButton>
        ) : null}
      </div>
      {adjusting && props.intent ? (
        <div className="inventory-maintenance-editor">
          <QuantityUnitField
            quantity={props.intent.stockQuantity ?? ''}
            unit={props.intent.stockUnit ?? props.group.stock_unit ?? '份'}
            unitOptions={[
              {
                value: props.intent.stockUnit ?? props.group.stock_unit ?? '份',
                label: props.intent.stockUnit ?? props.group.stock_unit ?? '份',
              },
            ]}
            quantityDisabled={props.busy}
            quantityStep="0.1"
            quantityFieldKey={`${targetKey}:stockQuantity`}
            unitFieldKey={`${targetKey}:stockUnit`}
            onQuantityChange={(value) =>
              props.onSetIntent(
                buildFoodSetStockIntent({
                  group: props.group,
                  stockQuantity: value,
                  stockUnit: props.intent?.stockUnit,
                  expiryDate: props.intent?.expiryDate,
                  storageLocation: props.intent?.storageLocation,
                }),
              )
            }
            onUnitChange={(value) =>
              props.onSetIntent(
                buildFoodSetStockIntent({
                  group: props.group,
                  stockQuantity: props.intent?.stockQuantity ?? '0',
                  stockUnit: value,
                  expiryDate: props.intent?.expiryDate,
                  storageLocation: props.intent?.storageLocation,
                }),
              )
            }
            className="inventory-maintenance-quantity"
          />
          <label className="inventory-maintenance-date-field">
            <span>存放位置（影响全部成品库存）</span>
            <input
              type="text"
              value={props.intent.storageLocation ?? ''}
              disabled={props.busy}
              data-field-key={`${targetKey}:storageLocation`}
              onChange={(event) =>
                props.onSetIntent(
                  buildFoodSetStockIntent({
                    group: props.group,
                    stockQuantity: props.intent?.stockQuantity ?? '0',
                    stockUnit: props.intent?.stockUnit,
                    expiryDate: props.intent?.expiryDate,
                    storageLocation: event.target.value,
                  }),
                )
              }
            />
          </label>
          <label className="inventory-maintenance-date-field">
            <span>到期日（可选）</span>
            <input
              type="date"
              value={props.intent.expiryDate ?? ''}
              disabled={props.busy}
              data-field-key={`${targetKey}:expiryDate`}
              onChange={(event) =>
                props.onSetIntent(
                  buildFoodSetStockIntent({
                    group: props.group,
                    stockQuantity: props.intent?.stockQuantity ?? '0',
                    stockUnit: props.intent?.stockUnit,
                    expiryDate: event.target.value || null,
                    storageLocation: props.intent?.storageLocation,
                  }),
                )
              }
            />
          </label>
          {[qtyError, unitError, storageError]
            .filter((error): error is ReconciliationFieldError => error !== null)
            .map((error) => (
              <p key={error.field} className="inventory-maintenance-field-error">
                {error.message}
              </p>
            ))}
        </div>
      ) : null}
    </div>
  );
}

function SummaryStep(props: {
  summary: ReconciliationSubmitSummary;
  draft: InventoryReconciliationDraft;
  groups: InventoryReconciliationGroup[];
}) {
  const lines = formatSubmitSummaryLines(props.summary);
  const groupByKey = useMemo(
    () => new Map(props.groups.map((group) => [reconciliationGroupTargetKey(group), group])),
    [props.groups],
  );

  return (
    <section className="inventory-maintenance-section" aria-label="提交摘要">
      <div className="inventory-maintenance-section-head">
        <span>将提交这些改动</span>
        <em>{props.summary.totalTouched} 项</em>
      </div>
      {lines.length === 0 ? (
        <p className="subtle">没有可提交的改动。</p>
      ) : (
        <ul className="inventory-maintenance-summary-list">
          {lines.map((line) => (
            <li key={line.label}>
              <strong>{line.label}</strong>
              <span>{line.count} 项</span>
            </li>
          ))}
        </ul>
      )}
      <ul className="inventory-maintenance-summary-list">
        {props.draft.intents.map((intent) => {
          const key = intentTargetKeySafe(intent);
          const group = groupByKey.get(key);
          const title =
            group == null
              ? key
              : group.kind === 'food'
                ? group.food_name
                : group.ingredient_name;
          return (
            <li key={key}>
              <strong>{title}</strong>
              <span>{intentActionLabel(intent)}</span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function intentTargetKeySafe(intent: ReconciliationIntent) {
  if (intent.kind === 'exact_ingredient') return `exact_ingredient:${intent.ingredientId}`;
  if (intent.kind === 'presence_ingredient') return `presence_ingredient:${intent.ingredientId}`;
  return `food:${intent.foodId}`;
}

function ResultStep(props: {
  result: InventoryOperationResult;
  busy?: boolean;
  onRevertResult?: (operationId: string) => void;
  onViewResult?: (operationId: string) => void;
}) {
  const canRevert = isOperationStillRevertible(props.result, Date.now());
  return (
    <section className="inventory-maintenance-result" aria-label="盘点结果">
      <div className="inventory-maintenance-summary-card">
        <p className="eyebrow">操作结果</p>
        <h4>{props.result.summary.title || '本次盘点已完成'}</h4>
        <p className="subtle">{props.result.summary.description}</p>
        <div className="inventory-maintenance-summary-metrics">
          <article>
            <span>确认</span>
            <strong>{props.result.summary.confirmed_count}</strong>
            <em>项</em>
          </article>
          <article>
            <span>调整</span>
            <strong>{props.result.summary.adjusted_count}</strong>
            <em>项</em>
          </article>
          <article>
            <span>状态</span>
            <strong>{props.result.status === 'applied' ? '已生效' : '已撤销'}</strong>
            <em />
          </article>
        </div>
        <p className="inventory-maintenance-revert-copy" aria-live="polite">
          {props.result.status === 'reverted'
            ? '这次操作已撤销'
            : canRevert
              ? `可在 ${compactTimeLabel(props.result.revertible_until)} 前撤销本次操作`
              : '撤销窗口已过或当前无权撤销'}
        </p>
        {(props.onViewResult || (canRevert && props.onRevertResult)) ? (
          <div className="inventory-operation-result-actions">
            {props.onViewResult ? (
              <ActionButton
                tone="secondary"
                size="compact"
                type="button"
                disabled={Boolean(props.busy)}
                onClick={() => props.onViewResult?.(props.result.operation_id)}
              >
                查看详情
              </ActionButton>
            ) : null}
            {canRevert && props.onRevertResult ? (
              <ActionButton
                tone="primary"
                size="compact"
                type="button"
                disabled={Boolean(props.busy)}
                onClick={() => props.onRevertResult?.(props.result.operation_id)}
              >
                撤销本次操作
              </ActionButton>
            ) : null}
          </div>
        ) : null}
      </div>
    </section>
  );
}
