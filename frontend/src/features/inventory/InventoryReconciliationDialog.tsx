import { useDeferredValue, useEffect, useMemo, useState, type ReactNode } from 'react';
import type {
  InventoryAvailabilityLevel,
  InventoryOperationResult,
  InventoryReconciliationGroup,
  InventoryStatus,
} from '../../api/types';
import {
  ActionButton,
  DropdownSelect,
  FormActions,
  MobileActionBar,
  OptionChipGroup,
  OperationLoadingOverlay,
  QuantityUnitField,
  StateBlock,
  WorkspaceModal,
  WorkspaceOverlayFrame,
} from '../../components/ui-kit';
import { formatDateTime } from '../../lib/ui';
import { convertQuantityToDefaultUnit, getIngredientUnitOptions } from '../../lib/ingredientUnits';
import { isOperationStillRevertible } from './InventoryOperationBanner';
import {
  AVAILABILITY_LEVEL_LABELS,
  buildBatchCreateIntent,
  buildBatchUpdateFromGroup,
  buildExactAdjustBatchesIntent,
  buildExactConfirmAllIntent,
  buildExactSetAbsentIntent,
  buildExactTotalAdjustmentSuggestion,
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
  type ExactTotalAdjustmentSuggestion,
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

const RECONCILIATION_STORAGE_OPTIONS = ['冷藏', '冷冻', '常温'].map((value) => ({
  value,
  label: value,
}));

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
    return '已加入本次盘点';
  }
  if (intent.kind === 'presence_ingredient') {
    return AVAILABILITY_LEVEL_LABELS[intent.availabilityLevel];
  }
  return '已加入本次盘点';
}

export function InventoryReconciliationDialog(props: InventoryReconciliationDialogProps) {
  const busy = Boolean(props.busy);
  const loading = Boolean(props.loading);
  const deferredOrderedGroups = useDeferredValue(props.orderedGroups);
  const isDeferringGroups =
    !loading && props.step === 'review' && deferredOrderedGroups !== props.orderedGroups;
  // Loading the read-only checklist must never trap the user in the overlay.
  // Only an in-flight inventory write needs to prevent closing or dismissal.
  const closeLocked = busy && !loading;
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
    if (!closeLocked) {
      props.onClose();
    }
  };

  const title =
    props.step === 'result'
      ? '盘点完成'
      : props.step === 'summary'
        ? '确认本次变更'
        : '快速盘点';

  const description =
    props.step === 'result'
      ? '库存记录已同步更新。'
      : props.step === 'summary'
        ? '只提交你确认或调整过的项目；未触碰项保持原状。'
        : `${scopeLabel(props.scope)}范围 · 逐项核对当前库存，未操作的项目不会被修改。`;

  const remainingErrorCount = fieldErrors.length;
  const isLoadError =
    !loading &&
    props.step === 'review' &&
    props.groups.length === 0 &&
    Boolean(props.errorMessage) &&
    (!props.conflictState || props.conflictState === 'none');
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
        primaryLabel={`查看本次变更（${checkedCount}）`}
        isSubmitting={closeLocked}
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
      closeOnBackdrop={!closeLocked}
      busy={closeLocked}
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
        className={[
          'workspace-modal-wide',
          'inventory-maintenance-modal',
          'inventory-reconciliation-modal',
          props.step === 'result' ? 'is-result' : '',
        ].filter(Boolean).join(' ')}
        onClose={closeIfAllowed}
        busy={closeLocked}
        footerInfo={props.step === 'result' ? undefined : footerInfo}
        footerActions={
          <>
            <div className="inventory-maintenance-desktop-actions">{footerActions}</div>
            <MobileActionBar className="inventory-maintenance-mobile-actions">{footerActions}</MobileActionBar>
          </>
        }
      >
        <div
          className={[
            'inventory-maintenance-scroll',
            'inventory-reconciliation-scroll',
            'ui-operation-loading-host',
            closeLocked ? 'is-busy' : '',
          ].filter(Boolean).join(' ')}
          aria-busy={closeLocked}
        >
          <OperationLoadingOverlay
            active={closeLocked}
            title={props.step === 'result' ? '正在撤销本次盘点' : '正在提交盘点结果'}
          />
          <div className="inventory-maintenance-live" aria-live="polite">
            {liveMessage}
          </div>

          {!loading && props.step !== 'result' ? (
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

          {props.errorMessage && !isLoadError && (!props.conflictState || props.conflictState === 'none') ? (
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

          {isLoadError ? (
            <StateBlock
              status="error"
              title="盘点清单没有加载完成"
              description={props.errorMessage ?? '请检查网络后重新加载，也可以先关闭稍后再试。'}
              actionLabel="重新加载"
              onAction={() => props.onChangeScope(props.scope)}
              className="inventory-maintenance-state inventory-reconciliation-load-error"
            />
          ) : null}

          {!loading && !isLoadError && props.step !== 'result' && props.groups.length === 0 ? (
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
              orderedGroups={deferredOrderedGroups}
              totalGroupCount={props.orderedGroups.length}
              isRenderingGroups={isDeferringGroups}
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
  totalGroupCount: number;
  isRenderingGroups: boolean;
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
      <aside className="inventory-maintenance-section inventory-reconciliation-side-summary" aria-label="本次摘要">
        <div className="inventory-maintenance-section-head">
          <span>本次摘要</span>
          <em>{props.summary.totalTouched} 项</em>
        </div>
        {summaryLines.length === 0 ? (
          <div className="inventory-reconciliation-summary-empty">
            <span className="inventory-reconciliation-summary-icon" aria-hidden="true">✓</span>
            <strong>从库存卡片开始确认</strong>
            <p className="subtle">只记录你确认、调整或清空的项目。</p>
            <span className="inventory-reconciliation-summary-remaining">
              待检查 {props.totalGroupCount} 项
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

      <section className="inventory-maintenance-section inventory-reconciliation-list" aria-label="库存清单">
        <div className="inventory-maintenance-section-head">
          <span>库存卡片</span>
          <em>{props.totalGroupCount} 项</em>
        </div>
        {props.isRenderingGroups ? (
          <div className="inventory-reconciliation-list-loading" role="status" aria-live="polite">
            <span aria-hidden="true" />
            <div>
              <strong>正在整理库存卡片</strong>
              <p>弹层可以继续操作，清单会马上显示。</p>
            </div>
          </div>
        ) : (
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
        )}
      </section>
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
          {headline.hasExpiredPhysicalBatch && props.group.kind !== 'exact_ingredient' ? (
            <span className="inventory-maintenance-chip is-warning">含过期批次</span>
          ) : null}
        </div>
        {props.group.kind === 'presence_ingredient' ? <p className="subtle">{headline.detail}</p> : null}
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
  const units = getIngredientUnitOptions({
    default_unit: props.group.default_unit || props.group.batches[0]?.unit || '个',
    unit_conversions: props.group.unit_conversions ?? [],
  });
  const primaryUnit = units[0]?.unit || props.group.batches[0]?.unit || '个';
  const zeroSuggestion = buildExactTotalAdjustmentSuggestion({
    group: props.group,
    actualQuantity: '0',
    actualUnit: primaryUnit,
    referenceDate: props.referenceDate,
  });
  const recordedQuantity = zeroSuggestion.ok
    ? zeroSuggestion.recordedQuantityInDefaultUnit
    : props.group.batches.reduce((sum, batch) => sum + Math.max(batch.remaining_quantity, 0), 0);
  const availableQuantity = zeroSuggestion.ok
    ? zeroSuggestion.availableQuantityInDefaultUnit
    : recordedQuantity;
  const physicalBatches = props.group.batches.filter((batch) => batch.remaining_quantity > 0);
  const expiredBatchCount = physicalBatches.filter((batch) =>
    isPhysicalBatchExpired(batch, props.referenceDate),
  ).length;
  const hasExpiredBatches = expiredBatchCount > 0;
  const allExpired = physicalBatches.length > 0 && expiredBatchCount === physicalBatches.length;
  const initialManualIntent =
    props.intent?.action === 'adjust_batches'
      ? props.intent
      : buildExactAdjustBatchesIntent({
          group: props.group,
          updates: physicalBatches
            .map((batch) => buildBatchUpdateFromGroup(props.group, batch.inventory_item_id))
            .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry)),
        });
  const [mode, setMode] = useState<'idle' | 'total' | 'manual'>(
    props.expanded || props.fieldErrors.length > 0 ? 'manual' : 'idle',
  );
  const [actualQuantity, setActualQuantity] = useState('');
  const [actualUnit, setActualUnit] = useState(primaryUnit);
  const [manualIntent, setManualIntent] = useState<ExactIngredientIntent | null>(initialManualIntent);
  const [expandedDetailIds, setExpandedDetailIds] = useState<string[]>(() =>
    props.fieldErrors.flatMap((error) => {
      const match = error.field.match(/^batch:([^:]+):/);
      return match ? [match[1]] : [];
    }),
  );
  const suggestion = useMemo(
    () =>
      actualQuantity.trim()
        ? buildExactTotalAdjustmentSuggestion({
            group: props.group,
            actualQuantity,
            actualUnit,
            referenceDate: props.referenceDate,
          })
        : null,
    [actualQuantity, actualUnit, props.group, props.referenceDate],
  );

  useEffect(() => {
    if (!props.expanded && props.fieldErrors.length === 0) return;
    if (props.intent?.action === 'adjust_batches') {
      setManualIntent(props.intent);
    }
    setExpandedDetailIds((current) => {
      const next = new Set(current);
      for (const error of props.fieldErrors) {
        const match = error.field.match(/^batch:([^:]+):/);
        if (match) next.add(match[1]);
      }
      return [...next];
    });
    setMode('manual');
  }, [props.expanded, props.fieldErrors, props.intent]);

  function formatQuantity(value: number) {
    return String(Number(value.toFixed(2)));
  }

  function openTotalEditor() {
    setActualUnit(primaryUnit);
    setActualQuantity(allExpired ? '' : formatQuantity(recordedQuantity));
    setMode('total');
  }

  function openExpirySuggestion() {
    setActualUnit(primaryUnit);
    setActualQuantity(formatQuantity(availableQuantity));
    setMode('total');
  }

  function buildCurrentBatchIntent() {
    return buildExactAdjustBatchesIntent({
      group: props.group,
      updates: physicalBatches
        .map((batch) => buildBatchUpdateFromGroup(props.group, batch.inventory_item_id))
        .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry)),
      creates: props.intent?.action === 'adjust_batches' ? props.intent.creates : [],
    });
  }

  function openManualEditor(seed?: ExactIngredientIntent | null) {
    setManualIntent(seed ?? (props.intent?.action === 'adjust_batches' ? props.intent : buildCurrentBatchIntent()));
    setExpandedDetailIds([]);
    setMode('manual');
  }

  if (props.intent && mode === 'idle') {
    const summary =
      props.intent.action === 'confirm_all'
        ? `数量没问题 · 记录库存 ${formatQuantity(recordedQuantity)} ${primaryUnit}`
        : props.intent.action === 'set_absent'
          ? `将清空 ${physicalBatches.length} 个批次 · 最终库存 0 ${primaryUnit}`
          : `将按批次修正库存 · 共 ${physicalBatches.length} 个批次`;
    return (
      <div className="inventory-reconciliation-selection-summary">
        <div>
          <span>已加入本次盘点</span>
          <strong>{summary}</strong>
        </div>
        <ActionButton tone="secondary" size="compact" type="button" disabled={props.busy} onClick={() => {
          if (props.intent?.action === 'adjust_batches') openManualEditor(props.intent);
          else openTotalEditor();
        }}>
          修改
        </ActionButton>
      </div>
    );
  }

  if (mode === 'total') {
    return (
      <div className="inventory-reconciliation-total-editor">
        <div className="inventory-maintenance-field-head">
          <span>家里实际还有多少？</span>
          <p className="subtle">先确认总量，系统再建议如何处理批次。</p>
        </div>
        <QuantityUnitField
          quantity={actualQuantity}
          unit={actualUnit}
          unitOptions={units.map((entry) => ({ value: entry.unit, label: entry.unit }))}
          quantityFieldKey={`${targetKey}:actualTotal`}
          onQuantityChange={setActualQuantity}
          onUnitChange={setActualUnit}
          className="inventory-reconciliation-total-field"
        />
        <div className={['inventory-reconciliation-suggestion', suggestion?.ok ? 'is-ready' : ''].filter(Boolean).join(' ')}>
          <span>系统建议</span>
          {!suggestion ? (
            <p>填写实际总量后，我会先处理过期和较早到期的批次。</p>
          ) : suggestion.ok ? (
            <>
              <strong>
                建议处理 {suggestion.processedBatchIds.length} 个批次，保留 {suggestion.retainedBatchIds.length} 个批次
              </strong>
              <p>
                记录库存 {formatQuantity(suggestion.recordedQuantityInDefaultUnit)} {primaryUnit}
                {' → '}实际库存 {formatQuantity(suggestion.actualQuantityInDefaultUnit)} {primaryUnit}
              </p>
            </>
          ) : (
            <p className="inventory-maintenance-field-error">{suggestion.message}</p>
          )}
        </div>
        <div className="inventory-reconciliation-editor-actions">
          <ActionButton
            tone="primary"
            size="compact"
            type="button"
            disabled={!suggestion?.ok || props.busy}
            onClick={() => {
              if (!suggestion?.ok) return;
              props.onSetIntent(suggestion.intent);
              setMode('idle');
            }}
          >
            接受建议
          </ActionButton>
          <ActionButton
            tone="secondary"
            size="compact"
            type="button"
            disabled={props.busy}
            onClick={() => openManualEditor(suggestion?.ok ? suggestion.intent : null)}
          >
            手动调整批次
          </ActionButton>
          <ActionButton tone="tertiary" size="compact" type="button" onClick={() => setMode('idle')}>
            返回
          </ActionButton>
          {props.intent ? (
            <ActionButton tone="tertiary" size="compact" type="button" onClick={() => {
              props.onClearIntent();
              setMode('idle');
            }}>
              移出本次盘点
            </ActionButton>
          ) : null}
        </div>
      </div>
    );
  }

  if (mode === 'manual' && manualIntent) {
    const manualSuggestion: ExactTotalAdjustmentSuggestion | null = suggestion?.ok ? suggestion : null;
    return (
      <div className="inventory-reconciliation-batch-workspace">
        <div className="inventory-reconciliation-batch-workspace-head">
          <ActionButton tone="tertiary" size="compact" type="button" onClick={() => setMode(actualQuantity ? 'total' : 'idle')}>
            返回盘点
          </ActionButton>
          <div>
            <strong>调整{props.group.ingredient_name}批次</strong>
            <span>逐批确认数量，需要时再修改日期和位置。</span>
          </div>
        </div>
        <ExactBatchEditor
          group={props.group}
          intent={manualIntent}
          suggestion={manualSuggestion}
          referenceDate={props.referenceDate}
          busy={props.busy}
          fieldErrors={props.fieldErrors}
          expandedDetailIds={expandedDetailIds}
          onToggleBatchDetail={(batchId) =>
            setExpandedDetailIds((current) =>
              current.includes(batchId)
                ? current.filter((entry) => entry !== batchId)
                : [...current, batchId],
            )
          }
          onSetIntent={setManualIntent}
        />
        <div className="inventory-reconciliation-batch-workspace-actions">
          <ActionButton tone="secondary" size="compact" type="button" onClick={() => setMode(actualQuantity ? 'total' : 'idle')}>
            取消
          </ActionButton>
          <ActionButton tone="primary" size="compact" type="button" disabled={props.busy} onClick={() => {
            props.onSetIntent(manualIntent);
            setMode('idle');
          }}>
            确认批次调整
          </ActionButton>
        </div>
      </div>
    );
  }

  return (
    <div className="inventory-reconciliation-group-actions">
      <div
        className={[
          'inventory-reconciliation-overview',
          hasExpiredBatches ? 'has-exception' : 'is-compact',
        ].join(' ')}
      >
        <div className="inventory-reconciliation-compact-stat">
          <span>{hasExpiredBatches ? '记录库存' : '系统记录'}</span>
          <strong>{formatQuantity(recordedQuantity)} {primaryUnit}</strong>
        </div>
        <div className="inventory-reconciliation-compact-stat">
          <span>{hasExpiredBatches ? '可用库存' : '可用'}</span>
          <strong>{formatQuantity(availableQuantity)} {primaryUnit}</strong>
        </div>
        <p>
          {allExpired
            ? `${physicalBatches.length} 个批次全部过期`
            : expiredBatchCount > 0
              ? `${expiredBatchCount} 个过期批次待处理`
              : `${physicalBatches.length} 个批次`}
        </p>
      </div>
      <div className="inventory-reconciliation-card-actions">
        <div className="inventory-reconciliation-primary-decisions">
          <ActionButton
            tone="primary"
            size="compact"
            type="button"
            disabled={props.busy}
            data-field-key={`${targetKey}:${allExpired ? 'set_absent' : 'confirm_all'}`}
            onClick={() => {
              if (allExpired) {
                props.onSetIntent(buildExactSetAbsentIntent(props.group));
                return;
              }
              if (hasExpiredBatches) {
                openExpirySuggestion();
                return;
              }
              props.onSetIntent(buildExactConfirmAllIntent(props.group));
            }}
          >
            {allExpired
              ? '这些已经处理'
              : hasExpiredBatches
                ? '处理过期批次'
                : `确认还是 ${formatQuantity(recordedQuantity)} ${primaryUnit}`}
          </ActionButton>
          <ActionButton
            tone="secondary"
            size="compact"
            type="button"
            disabled={props.busy}
            data-field-key={`${targetKey}:correct_total`}
            onClick={openTotalEditor}
          >
            {allExpired ? '家里实际还有' : hasExpiredBatches ? '家里实际数量' : '实际数量不同'}
          </ActionButton>
        </div>
        <ActionButton tone="tertiary" size="compact" type="button" disabled={props.busy} onClick={() => openManualEditor()}>
          批次明细（{physicalBatches.length}）
        </ActionButton>
      </div>
    </div>
  );
}

function ExactBatchEditor(props: {
  group: Extract<InventoryReconciliationGroup, { kind: 'exact_ingredient' }>;
  intent: ExactIngredientIntent | null;
  suggestion?: ExactTotalAdjustmentSuggestion | null;
  referenceDate: string;
  busy: boolean;
  fieldErrors: ReconciliationFieldError[];
  expandedDetailIds: string[];
  onToggleBatchDetail: (batchId: string) => void;
  onSetIntent: (intent: ExactIngredientIntent) => void;
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
  const suggestedProcessIds = new Set(
    props.suggestion?.ok
      ? props.suggestion.processedBatchIds
      : props.group.batches
          .filter((batch) => isPhysicalBatchExpired(batch, props.referenceDate))
          .map((batch) => batch.inventory_item_id),
  );
  const sortedBatches = [...props.group.batches.filter((batch) => batch.remaining_quantity > 0)].sort(
    (left, right) => {
      const leftGroup = suggestedProcessIds.has(left.inventory_item_id) ? 0 : 1;
      const rightGroup = suggestedProcessIds.has(right.inventory_item_id) ? 0 : 1;
      if (leftGroup !== rightGroup) return leftGroup - rightGroup;
      return (left.expiry_date || '9999-12-31').localeCompare(right.expiry_date || '9999-12-31');
    },
  );

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
      {sortedBatches.map((batch, index) => {
          const previousBatch = sortedBatches[index - 1];
          const groupLabel = suggestedProcessIds.has(batch.inventory_item_id) ? '建议处理' : '建议保留';
          const previousGroupLabel = previousBatch
            ? suggestedProcessIds.has(previousBatch.inventory_item_id) ? '建议处理' : '建议保留'
            : null;
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
          const detailExpanded = props.expandedDetailIds.includes(batch.inventory_item_id);
          return (
            <div key={batch.inventory_item_id} className="inventory-reconciliation-batch-entry">
              {groupLabel !== previousGroupLabel ? (
                <div className={`inventory-reconciliation-batch-group-label is-${groupLabel === '建议处理' ? 'process' : 'retain'}`}>
                  <strong>{groupLabel}</strong>
                  <span>{groupLabel === '建议处理' ? '优先处理过期或较早批次' : '建议保留较新批次'}</span>
                </div>
              ) : null}
            <div
              className={['inventory-reconciliation-batch-row', expired ? 'is-expired' : '']
                .filter(Boolean)
                .join(' ')}
            >
              <div className="inventory-maintenance-item-title-row">
                <strong>
                  {batch.purchase_date.slice(5).replace('-', ' 月 ')} 日购买 · {batch.storage_location || '未设位置'}
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
              <ActionButton
                tone="tertiary"
                size="compact"
                type="button"
                onClick={() => props.onToggleBatchDetail(batch.inventory_item_id)}
              >
                {detailExpanded ? '收起详情' : '修改详情'}
              </ActionButton>
              {detailExpanded ? <div className="inventory-reconciliation-batch-fields">
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
              </div> : null}
              {batchErrors.map((error) => (
                <p key={error.field} className="inventory-maintenance-field-error">
                  {error.message}
                </p>
              ))}
            </div>
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
  const initialEditing = props.fieldErrors.length > 0;
  const [editing, setEditing] = useState(initialEditing);
  const [quantity, setQuantity] = useState(
    props.intent?.action === 'set_stock' && props.intent.stockQuantity !== null
      ? props.intent.stockQuantity
      : props.group.stock_quantity > 0
        ? String(props.group.stock_quantity)
        : '',
  );
  const [unit, setUnit] = useState(
    props.intent?.action === 'set_stock'
      ? props.intent.stockUnit || props.group.stock_unit || '份'
      : props.group.stock_unit || '份',
  );
  const [storageLocation, setStorageLocation] = useState(
    props.intent?.action === 'set_stock'
      ? props.intent.storageLocation || props.group.storage_location || '冷藏'
      : props.group.storage_location || '冷藏',
  );
  const [expiryDate, setExpiryDate] = useState(
    props.intent?.action === 'set_stock'
      ? props.intent.expiryDate || props.group.expiry_date || ''
      : props.group.expiry_date || '',
  );
  const qtyError = fieldErrorFor(props.fieldErrors, targetKey, 'stockQuantity');
  const unitError = fieldErrorFor(props.fieldErrors, targetKey, 'stockUnit');
  const storageError = fieldErrorFor(props.fieldErrors, targetKey, 'storageLocation');
  const parsedQuantity = Number(quantity);
  const canConfirmActual = Number.isFinite(parsedQuantity) && parsedQuantity > 0;

  useEffect(() => {
    if (props.fieldErrors.length > 0) setEditing(true);
  }, [props.fieldErrors]);

  if (props.intent && !editing) {
    const summary =
      props.intent.action === 'confirm'
        ? `数量没问题 · 当前 ${props.group.stock_quantity} ${props.group.stock_unit || '份'}`
        : props.intent.stockQuantity === '0'
          ? `确认家里没有 · 最终库存 0 ${props.group.stock_unit || '份'}`
          : `修正为 ${props.intent.stockQuantity} ${props.intent.stockUnit || props.group.stock_unit || '份'} · ${props.intent.storageLocation || '未设位置'}`;
    return (
      <div className="inventory-reconciliation-selection-summary">
        <div>
          <span>已加入本次盘点</span>
          <strong>{summary}</strong>
        </div>
        <ActionButton tone="secondary" size="compact" type="button" onClick={() => setEditing(true)}>
          修改
        </ActionButton>
      </div>
    );
  }

  if (editing) {
    return (
      <div className="inventory-reconciliation-food-editor">
        <div className="inventory-maintenance-field-head">
          <span>家里实际还有多少？</span>
          <p className="subtle">按总量记录，不需要逐盒或逐袋拆分。</p>
        </div>
        <QuantityUnitField
          quantity={quantity}
          unit={unit}
          unitOptions={[{ value: unit, label: unit }]}
          quantityDisabled={props.busy}
          quantityStep="0.1"
          quantityFieldKey={`${targetKey}:stockQuantity`}
          unitFieldKey={`${targetKey}:stockUnit`}
          onQuantityChange={setQuantity}
          onUnitChange={setUnit}
          className="inventory-maintenance-quantity"
        />
        <div className="inventory-reconciliation-food-meta-fields">
          <label className="inventory-maintenance-date-field">
            <span>存放位置</span>
            <DropdownSelect
              ariaLabel="存放位置"
              placeholder="选择存放位置"
              value={storageLocation}
              options={RECONCILIATION_STORAGE_OPTIONS}
              triggerFieldKey={`${targetKey}:storageLocation`}
              onChange={setStorageLocation}
            />
          </label>
          <label className="inventory-maintenance-date-field">
            <span>到期日（可选）</span>
            <input
              type="date"
              value={expiryDate}
              disabled={props.busy}
              data-field-key={`${targetKey}:expiryDate`}
              onChange={(event) => setExpiryDate(event.target.value)}
            />
          </label>
        </div>
        {[qtyError, unitError, storageError]
          .filter((error): error is ReconciliationFieldError => error !== null)
          .map((error) => (
            <p key={error.field} className="inventory-maintenance-field-error">{error.message}</p>
          ))}
        <div className="inventory-reconciliation-editor-actions">
          <ActionButton
            tone="primary"
            size="compact"
            type="button"
            disabled={props.busy || !canConfirmActual}
            onClick={() => {
              props.onSetIntent(buildFoodSetStockIntent({
                group: props.group,
                stockQuantity: quantity,
                stockUnit: unit,
                expiryDate: expiryDate || null,
                storageLocation,
              }));
              setEditing(false);
            }}
          >
            确认实际库存
          </ActionButton>
          <ActionButton tone="secondary" size="compact" type="button" onClick={() => setEditing(false)}>
            返回
          </ActionButton>
          {props.intent ? (
            <ActionButton tone="tertiary" size="compact" type="button" onClick={() => {
              props.onClearIntent();
              setEditing(false);
            }}>
              移出本次盘点
            </ActionButton>
          ) : null}
        </div>
      </div>
    );
  }

  return (
    <div className="inventory-reconciliation-group-actions">
      <div className="inventory-reconciliation-food-question" role="note">
        <span>按总量记录</span>
        <strong>家里现在还有{props.group.food_name}吗？</strong>
        <p>系统当前记录 {props.group.stock_quantity} {props.group.stock_unit || '份'}，只需要确认家里的实际总量。</p>
      </div>
      <div className="inventory-reconciliation-primary-decisions">
        <ActionButton
          tone="primary"
          size="compact"
          type="button"
          disabled={props.busy}
          data-field-key={`${targetKey}:${props.group.stock_quantity > 0 ? 'confirm' : 'set_absent'}`}
          onClick={() => props.onSetIntent(
            props.group.stock_quantity > 0
              ? buildFoodConfirmIntent(props.group)
              : buildFoodSetAbsentIntent(props.group),
          )}
        >
          {props.group.stock_quantity > 0 ? '数量没问题' : '确认家里没有'}
        </ActionButton>
        <ActionButton
          tone="secondary"
          size="compact"
          type="button"
          disabled={props.busy}
          data-field-key={`${targetKey}:set_stock`}
          onClick={() => setEditing(true)}
        >
          {props.group.stock_quantity > 0 ? '修正实际库存' : '家里实际有'}
        </ActionButton>
      </div>
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

  function exactIntentSummary(
    group: Extract<InventoryReconciliationGroup, { kind: 'exact_ingredient' }>,
    intent: ExactIngredientIntent,
  ) {
    const unitProfile = {
      default_unit: group.default_unit || group.batches[0]?.unit || '个',
      unit_conversions: group.unit_conversions ?? [],
    };
    const recorded = group.batches.reduce((sum, batch) => {
      const normalized = convertQuantityToDefaultUnit(
        unitProfile,
        Math.max(batch.remaining_quantity, 0),
        batch.unit,
      );
      return sum + (normalized ?? 0);
    }, 0);
    if (intent.action === 'confirm_all') {
      return `数量没问题 · 记录库存 ${Number(recorded.toFixed(2))} ${unitProfile.default_unit}`;
    }
    if (intent.action === 'set_absent') {
      const batchCount = group.batches.filter((batch) => batch.remaining_quantity > 0).length;
      return `清空 ${batchCount} 个批次 · ${Number(recorded.toFixed(2))} → 0 ${unitProfile.default_unit}`;
    }
    const updatesById = new Map(intent.updates.map((update) => [update.inventoryItemId, update]));
    const actualFromBatches = group.batches.reduce((sum, batch) => {
      const update = updatesById.get(batch.inventory_item_id);
      const normalized = convertQuantityToDefaultUnit(
        unitProfile,
        Number(update?.actualRemainingQuantity ?? batch.remaining_quantity),
        batch.unit,
      );
      return sum + (normalized ?? 0);
    }, 0);
    const actualFromCreates = intent.creates.reduce((sum, create) => {
      const normalized = convertQuantityToDefaultUnit(
        unitProfile,
        Number(create.actualRemainingQuantity),
        create.unit,
      );
      return sum + (normalized ?? 0);
    }, 0);
    const clearedCount = intent.updates.filter(
      (update) => Number(update.actualRemainingQuantity) === 0,
    ).length;
    return `${Number(recorded.toFixed(2))} → ${Number((actualFromBatches + actualFromCreates).toFixed(2))} ${unitProfile.default_unit} · ${clearedCount > 0 ? `清空 ${clearedCount} 个批次` : '按批次修正'}`;
  }

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
            <li key={key} className="inventory-reconciliation-submit-item">
              <div>
                <strong>{title}</strong>
                <span>
                  {group?.kind === 'exact_ingredient' && intent.kind === 'exact_ingredient'
                    ? exactIntentSummary(group, intent)
                    : intentActionLabel(intent)}
                </span>
              </div>
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
  const applied = props.result.status === 'applied';
  return (
    <section className="inventory-maintenance-result inventory-reconciliation-result" aria-label="盘点结果">
      <div className={['inventory-reconciliation-result-head', applied ? 'is-applied' : 'is-reverted'].join(' ')}>
        <span className="inventory-reconciliation-result-mark" aria-hidden="true">✓</span>
        <div>
          <span>{applied ? '操作成功' : '操作已撤销'}</span>
          <strong>{applied ? '家庭库存已经更新' : '库存已经恢复到操作前'}</strong>
          <p>{props.result.summary.description}</p>
        </div>
      </div>

      <div className="inventory-reconciliation-result-metrics" aria-label="盘点统计">
        <article className="inventory-reconciliation-result-metric">
          <span>确认</span>
          <strong>{props.result.summary.confirmed_count}</strong>
          <em>项</em>
        </article>
        <article className="inventory-reconciliation-result-metric">
          <span>调整</span>
          <strong>{props.result.summary.adjusted_count}</strong>
          <em>项</em>
        </article>
        <article className="inventory-reconciliation-result-metric is-status">
          <span>状态</span>
          <strong>{applied ? '已生效' : '已撤销'}</strong>
        </article>
      </div>

      <p className="inventory-reconciliation-result-notice" aria-live="polite">
        {props.result.status === 'reverted'
          ? '这次操作已撤销'
          : canRevert
            ? `可在 ${compactTimeLabel(props.result.revertible_until)} 前撤销本次操作`
            : '撤销窗口已过或当前无权撤销'}
      </p>
      {(props.onViewResult || (canRevert && props.onRevertResult)) ? (
        <div className="inventory-operation-result-actions inventory-reconciliation-result-actions">
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
              tone="secondary"
              size="compact"
              type="button"
              className="inventory-reconciliation-result-revert"
              disabled={Boolean(props.busy)}
              onClick={() => props.onRevertResult?.(props.result.operation_id)}
            >
              撤销本次操作
            </ActionButton>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
