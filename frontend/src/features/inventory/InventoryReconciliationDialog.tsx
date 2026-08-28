import { useDeferredValue, useEffect, useMemo, useState, type ReactNode } from 'react';
import type {
  InventoryAvailabilityLevel,
  InventoryOperationResult,
  InventoryReconciliationGroup,
  InventoryStatus,
} from '../../api/types/inventory';
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
import { InventoryReconciliationScopeStep } from './InventoryReconciliationScopeStep';
import { InventoryReconciliationSummaryStep } from './InventoryReconciliationSummaryStep';
import { InventoryReconciliationResultStep } from './InventoryReconciliationResultStep';

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
      ? '库存已更新。'
      : props.step === 'summary'
        ? '只提交你确认或调整过的内容；没有改动的库存不会变化。'
        : `核对${scopeLabel(props.scope)}范围内的库存；没有改动的内容不会变化。`;

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
    (remainingErrorCount > 0 ? `还有 ${remainingErrorCount} 项需要确认` : null) ||
    (props.step === 'result' && props.result
      ? canRevertResult
        ? `可在 ${compactTimeLabel(props.result.revertible_until)} 前撤销`
        : props.result.status === 'reverted'
          ? '这次盘点已撤销'
          : '已超过可撤销时间，或你没有撤销权限'
      : `已核对 ${checkedCount} / ${totalCount}`);

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
        primaryLabel={busy ? '正在保存…' : '确认并完成盘点'}
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
                ? '这次盘点已撤销'
                : '已超过可撤销时间，或你没有撤销权限'}
          </p>
        </>
      ) : (
        <>
          <span>已核对</span>
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
            <InventoryReconciliationScopeStep
              scope={props.scope}
              checkedCount={checkedCount}
              totalCount={totalCount}
              disabled={busy || loading}
              onChange={props.onChangeScope}
            />
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
              title="这个范围里没有需要盘点的库存"
              description="可以换一个范围，或稍后再来。"
              className="inventory-maintenance-state"
            />
          ) : null}

          {!loading && props.step === 'review' && props.draft ? (
            <InventoryReconciliationReviewStep
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
            <InventoryReconciliationSummaryStep summary={summary} draft={props.draft} groups={props.groups} />
          ) : null}

          {!loading && props.step === 'result' && props.result ? (
            <InventoryReconciliationResultStep
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

import { InventoryReconciliationReviewStep } from './InventoryReconciliationReviewStep';
