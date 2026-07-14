import { useEffect, useMemo, useState, type ReactNode } from 'react';
import type { VersionedInventoryItemRef } from '../../api/types';
import {
  ActionButton,
  FormActions,
  OperationLoadingOverlay,
  OptionChipGroup,
  StatusBadge,
  WorkspaceModal,
  WorkspaceOverlayFrame,
} from '../../components/ui-kit';
import { addCalendarDaysToDateKey } from '../../lib/date';
import { formatDate, formatDateTime } from '../../lib/ui';
import type { ExpiryInventoryActionGroup, InventoryActionBatch } from './inventoryActionModel';

export type InventoryActionDialogMode =
  | { kind: 'review'; focus: 'default' | 'dispose' }
  | { kind: 'dispose_confirm' }
  | { kind: 'snooze'; audience: 'expired' | 'upcoming' }
  | { kind: 'correct_date'; inventoryItemId: string };

export type InventoryActionDialogProps = {
  open: boolean;
  group: ExpiryInventoryActionGroup;
  referenceDate: string;
  busy?: boolean;
  errorMessage?: string | null;
  conflictState?: 'none' | 'review_again';
  overlayRootClassName?: string;
  onClose: () => void;
  onDispose: (items: VersionedInventoryItemRef[]) => Promise<void>;
  onSnooze: (args: {
    action: 'retain_expired' | 'snooze_upcoming';
    items: VersionedInventoryItemRef[];
    snoozedUntil: string;
  }) => Promise<void>;
  onCorrectExpiry: (args: {
    inventoryItemId: string;
    expectedRowVersion: number;
    expiryDate: string;
  }) => Promise<void>;
};

type SelectionAudience = 'expired' | 'upcoming' | 'all';
type SnoozePreset = 'tomorrow' | 'three_days' | 'custom';
type HandlingIntent = 'dispose' | 'retain' | 'snooze';

function formatQuantityValue(value: number) {
  return String(Number(value.toFixed(2))).replace(/\.0+$/, '');
}

function buildQuantityLabels(batches: Array<{ remainingQuantity: number; unit: string }>) {
  const totals = new Map<string, number>();
  const order: string[] = [];
  for (const batch of batches) {
    if (!totals.has(batch.unit)) {
      order.push(batch.unit);
    }
    totals.set(batch.unit, (totals.get(batch.unit) ?? 0) + batch.remainingQuantity);
  }
  return order.map((unit) => `${formatQuantityValue(totals.get(unit) ?? 0)} ${unit}`);
}

function isExpiredBatch(batch: InventoryActionBatch) {
  return batch.daysLeft < 0;
}

function isPresenceGroup(group: ExpiryInventoryActionGroup) {
  return group.targetKind === 'ingredient_inventory_state' || group.batches.some((batch) => batch.presenceOnly);
}

function defaultSelectedIds(group: ExpiryInventoryActionGroup) {
  const expired = group.batches.filter(isExpiredBatch).map((batch) => batch.inventoryItemId);
  if (expired.length > 0) {
    return expired;
  }
  return group.batches.map((batch) => batch.inventoryItemId);
}

function validIdsForAudience(group: ExpiryInventoryActionGroup, audience: SelectionAudience) {
  if (audience === 'expired') {
    return group.batches.filter(isExpiredBatch).map((batch) => batch.inventoryItemId);
  }
  if (audience === 'upcoming') {
    return group.batches.filter((batch) => !isExpiredBatch(batch)).map((batch) => batch.inventoryItemId);
  }
  return group.batches.map((batch) => batch.inventoryItemId);
}

function toVersionedRefs(group: ExpiryInventoryActionGroup, selectedIds: string[]): VersionedInventoryItemRef[] {
  const selected = new Set(selectedIds);
  return group.batches
    .filter((batch) => selected.has(batch.inventoryItemId))
    .map((batch) => ({
      inventory_item_id: batch.inventoryItemId,
      expected_row_version: batch.rowVersion,
    }));
}

function batchStatusCopy(batch: InventoryActionBatch) {
  if (batch.daysLeft < 0) {
    return `已过期 ${Math.abs(batch.daysLeft)} 天`;
  }
  if (batch.daysLeft === 0) {
    return '今天到期';
  }
  if (batch.daysLeft === 1) {
    return '明天到期';
  }
  return `${batch.daysLeft} 天后到期`;
}

function compactDateLabel(date: string) {
  const key = date.slice(0, 10);
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
  if (!match) {
    return formatDate(date);
  }
  return `${Number(match[2])}月${Number(match[3])}日`;
}

function priorReviewCopy(batch: InventoryActionBatch) {
  if (batch.expiryReviewedAt) {
    const when = formatDateTime(batch.expiryReviewedAt);
    if (batch.expiryAlertSnoozedUntil) {
      return {
        title: '此前已确认暂时保留',
        detail: `原到期日仍保留，将于 ${compactDateLabel(batch.expiryAlertSnoozedUntil)} 再次提醒 · ${when}`,
      };
    }
    return {
      title: '此前已确认暂时保留',
      detail: `原到期日仍保留 · ${when}`,
    };
  }
  if (batch.expiryAlertSnoozedUntil) {
    return {
      title: '已设置稍后提醒',
      detail: `将于 ${compactDateLabel(batch.expiryAlertSnoozedUntil)} 再次提醒`,
    };
  }
  return null;
}

function selectionAudienceForMode(
  mode: InventoryActionDialogMode,
  hasExpired: boolean,
): SelectionAudience {
  if (mode.kind === 'dispose_confirm') return 'expired';
  if (mode.kind === 'review' && mode.focus === 'dispose') return 'expired';
  if (mode.kind === 'snooze') return mode.audience;
  return hasExpired ? 'expired' : 'upcoming';
}

export function InventoryActionDialog(props: InventoryActionDialogProps) {
  const busy = Boolean(props.busy);
  const group = props.group;
  const conflictState = props.conflictState ?? 'none';

  const [mode, setMode] = useState<InventoryActionDialogMode>({ kind: 'review', focus: 'default' });
  const [selectedIds, setSelectedIds] = useState<string[]>(() => defaultSelectedIds(group));
  const [snoozePreset, setSnoozePreset] = useState<SnoozePreset>('tomorrow');
  const [customSnoozeDate, setCustomSnoozeDate] = useState('');
  const [correctedExpiryDate, setCorrectedExpiryDate] = useState('');
  const [localError, setLocalError] = useState<string | null>(null);

  const tomorrowKey = useMemo(
    () => addCalendarDaysToDateKey(props.referenceDate, 1),
    [props.referenceDate],
  );
  const threeDaysKey = useMemo(
    () => addCalendarDaysToDateKey(props.referenceDate, 3),
    [props.referenceDate],
  );
  const maxSnoozeKey = useMemo(
    () => addCalendarDaysToDateKey(props.referenceDate, 30),
    [props.referenceDate],
  );

  useEffect(() => {
    if (!props.open) {
      return;
    }
    setMode({ kind: 'review', focus: 'default' });
    setSelectedIds(defaultSelectedIds(group));
    setSnoozePreset('tomorrow');
    setCustomSnoozeDate('');
    setCorrectedExpiryDate('');
    setLocalError(null);
  }, [props.open, group, props.referenceDate, conflictState]);

  if (!props.open) {
    return null;
  }

  const expiredBatches = group.batches.filter(isExpiredBatch);
  const upcomingBatches = group.batches.filter((batch) => !isExpiredBatch(batch));
  const audience = selectionAudienceForMode(mode, group.batches.some(isExpiredBatch));
  const validIdList = validIdsForAudience(group, audience);
  const validIds = new Set(validIdList);
  const selectedBatches = group.batches.filter(
    (batch) => selectedIds.includes(batch.inventoryItemId) && validIds.has(batch.inventoryItemId),
  );
  const selectedQuantityLabels = buildQuantityLabels(selectedBatches);
  const hasExpired = expiredBatches.length > 0;
  const hasUpcoming = upcomingBatches.length > 0;
  const selectedValidCount = selectedBatches.length;
  const showsBatchList = mode.kind === 'review' || mode.kind === 'dispose_confirm' || mode.kind === 'snooze';

  const closeIfAllowed = () => {
    if (!busy) {
      props.onClose();
    }
  };

  function applyAudienceSelection(nextAudience: SelectionAudience) {
    setSelectedIds(validIdsForAudience(group, nextAudience));
    setLocalError(null);
  }

  function selectDisposeIntent() {
    if (busy) return;
    applyAudienceSelection('expired');
    setMode({ kind: 'review', focus: 'dispose' });
  }

  function enterDisposeConfirmation() {
    if (busy) return;
    setMode({ kind: 'dispose_confirm' });
  }

  function enterRetainExpired() {
    if (busy) return;
    applyAudienceSelection('expired');
    setMode({ kind: 'snooze', audience: 'expired' });
  }

  function enterSnoozeUpcoming() {
    if (busy) return;
    applyAudienceSelection('upcoming');
    setMode({ kind: 'snooze', audience: 'upcoming' });
  }

  function enterCorrectDate(inventoryItemId: string) {
    if (busy) return;
    const batch = group.batches.find((item) => item.inventoryItemId === inventoryItemId);
    setCorrectedExpiryDate(batch?.expiryDate ?? '');
    setMode({ kind: 'correct_date', inventoryItemId });
    setLocalError(null);
  }

  function toggleBatch(inventoryItemId: string) {
    if (busy || !validIds.has(inventoryItemId)) {
      return;
    }
    setSelectedIds((current) =>
      current.includes(inventoryItemId)
        ? current.filter((id) => id !== inventoryItemId)
        : [...current, inventoryItemId],
    );
    setLocalError(null);
  }

  function resolveSnoozeDate() {
    if (snoozePreset === 'tomorrow') return tomorrowKey;
    if (snoozePreset === 'three_days') return threeDaysKey;
    return customSnoozeDate;
  }

  function isValidSnoozeDate(value: string) {
    if (!value) return false;
    return value > props.referenceDate && value <= maxSnoozeKey;
  }

  async function submitDispose() {
    if (busy || mode.kind !== 'dispose_confirm') return;
    if (selectedValidCount === 0) {
      setLocalError('请先选择要销毁的过期批次。');
      return;
    }
    setLocalError(null);
    try {
      await props.onDispose(toVersionedRefs(group, selectedIds));
    } catch {
      // Parent retains dialog and surfaces conflict/error state.
    }
  }

  async function submitSnooze() {
    if (busy || mode.kind !== 'snooze') return;
    const snoozedUntil = resolveSnoozeDate();
    if (!isValidSnoozeDate(snoozedUntil)) {
      setLocalError('提醒日期必须晚于今天，且不超过 30 天。');
      return;
    }
    if (selectedValidCount === 0) {
      setLocalError(mode.audience === 'expired' ? '请先选择要暂时保留的过期批次。' : '请先选择要稍后提醒的批次。');
      return;
    }
    setLocalError(null);
    try {
      await props.onSnooze({
        action: mode.audience === 'expired' ? 'retain_expired' : 'snooze_upcoming',
        items: toVersionedRefs(group, selectedIds),
        snoozedUntil,
      });
    } catch {
      // Parent retains dialog and surfaces conflict/error state.
    }
  }

  async function submitCorrection() {
    if (busy || mode.kind !== 'correct_date') return;
    if (!correctedExpiryDate) {
      setLocalError('请填写更正后的到期日。');
      return;
    }
    const batch = group.batches.find((item) => item.inventoryItemId === mode.inventoryItemId);
    if (!batch) {
      setLocalError('找不到要更正的批次。');
      return;
    }
    setLocalError(null);
    try {
      await props.onCorrectExpiry({
        inventoryItemId: batch.inventoryItemId,
        expectedRowVersion: batch.rowVersion,
        expiryDate: correctedExpiryDate,
      });
    } catch {
      // Parent retains dialog and surfaces conflict/error state.
    }
  }

  const title =
    mode.kind === 'dispose_confirm'
      ? (isPresenceGroup(group) ? `确认${group.ingredientName}已经没有` : `确认销毁${group.ingredientName}`)
      : mode.kind === 'correct_date'
        ? `更正${group.ingredientName}到期日`
        : mode.kind === 'snooze'
          ? mode.audience === 'expired'
            ? `暂时保留${group.ingredientName}`
            : `稍后提醒${group.ingredientName}`
          : group.title;

  const description =
    mode.kind === 'dispose_confirm'
      ? isPresenceGroup(group)
        ? `将把${group.ingredientName}标记为已经没有。此操作不可撤销。`
        : `将销毁 ${selectedValidCount} 个批次（${selectedQuantityLabels.join('、') || '无数量'}）。此操作不可撤销。`
      : mode.kind === 'correct_date'
        ? '只会改这一批的到期日，并清空此前的延后提醒记录。'
        : mode.kind === 'snooze'
          ? mode.audience === 'expired'
            ? '保留原到期日作为证据，并设置下次提醒。'
            : '未过期批次只推迟提醒，不会改写为过期审核。'
          : group.detail;

  const errorText = localError ?? props.errorMessage ?? null;
  const handlingIntent: HandlingIntent = mode.kind === 'snooze'
    ? mode.audience === 'expired' ? 'retain' : 'snooze'
    : hasExpired ? 'dispose' : 'snooze';
  const handlingOptions: Array<{ value: HandlingIntent; label: string }> = [
    ...(hasExpired
      ? [
          { value: 'dispose' as const, label: isPresenceGroup(group) ? '记为没有' : '销毁' },
          { value: 'retain' as const, label: '暂时保留' },
        ]
      : []),
    ...(hasUpcoming ? [{ value: 'snooze' as const, label: '稍后提醒' }] : []),
  ];

  const footerInfo = (
    <>
      <span>已选择</span>
      <strong>
        {isPresenceGroup(group) ? (
          <span>家庭整体有无</span>
        ) : (
          <>
            <span>{selectedValidCount} 个批次</span>
            {selectedQuantityLabels.length > 0 ? (
              <span className="inventory-action-footer-quantity"> · {selectedQuantityLabels.join('、')}</span>
            ) : null}
          </>
        )}
      </strong>
      {mode.kind === 'dispose_confirm' ? (
        <p>
          {isPresenceGroup(group)
            ? `${group.ingredientName} · 将标记为没有`
            : `${group.ingredientName} · ${selectedValidCount} 批 · ${selectedQuantityLabels.join('、') || '无数量'}`}
        </p>
      ) : (
        <p>{group.ingredientName}</p>
      )}
    </>
  );

  let footerActions: ReactNode;

  if (mode.kind === 'dispose_confirm') {
    footerActions = (
      <FormActions
        primaryLabel={isPresenceGroup(group) ? '确认没有了' : '确认销毁'}
        primaryTone="danger"
        isSubmitting={busy}
        primaryDisabled={busy || selectedValidCount === 0}
        onPrimary={() => {
          void submitDispose();
        }}
        secondaryLabel="返回"
        onSecondary={() => {
          if (!busy) setMode({ kind: 'review', focus: 'dispose' });
        }}
      />
    );
  } else if (mode.kind === 'snooze') {
    footerActions = (
      <FormActions
        primaryLabel={mode.audience === 'expired' ? '确认暂时保留' : '确认稍后提醒'}
        isSubmitting={busy}
        primaryDisabled={busy || selectedValidCount === 0}
        onPrimary={() => {
          void submitSnooze();
        }}
        secondaryLabel="返回"
        onSecondary={() => {
          if (!busy) {
            setMode({ kind: 'review', focus: 'default' });
            setSelectedIds(defaultSelectedIds(group));
          }
        }}
      />
    );
  } else if (mode.kind === 'correct_date') {
    footerActions = (
      <FormActions
        primaryLabel="保存更正"
        isSubmitting={busy}
        primaryDisabled={busy}
        onPrimary={() => {
          void submitCorrection();
        }}
        secondaryLabel="返回"
        onSecondary={() => {
          if (!busy) setMode({ kind: 'review', focus: 'default' });
        }}
      />
    );
  } else {
    footerActions = (
      <FormActions
        primaryLabel={hasExpired ? (isPresenceGroup(group) ? '标记为没有' : '销毁所选批次') : '关闭'}
        primaryTone={hasExpired ? 'danger' : 'primary'}
        isSubmitting={busy}
        primaryDisabled={busy || (hasExpired && selectedValidCount === 0)}
        onPrimary={() => {
          if (hasExpired) {
            enterDisposeConfirmation();
            return;
          }
          closeIfAllowed();
        }}
        secondaryLabel="取消"
        onSecondary={closeIfAllowed}
      />
    );
  }

  return (
    <WorkspaceOverlayFrame
      rootClassName={props.overlayRootClassName}
      closeOnBackdrop={!busy}
      busy={busy}
      labelledBy="inventory-action-dialog-title"
      onClose={closeIfAllowed}
    >
      <WorkspaceModal
        title={title}
        titleId="inventory-action-dialog-title"
        description={description}
        closeLabel="关闭"
        closeAriaLabel="关闭"
        className="workspace-modal-wide"
        busy={busy}
        onClose={closeIfAllowed}
        footerInfo={footerInfo}
        footerActions={footerActions}
      >
        <div
          className={[
            'inventory-action-content',
            'ui-operation-loading-host',
            busy ? 'is-busy' : '',
          ].filter(Boolean).join(' ')}
          aria-busy={busy}
        >
          <OperationLoadingOverlay active={busy} title="正在处理库存" />
          {conflictState === 'review_again' ? (
            <div className="inventory-action-conflict" role="status">
              <strong>需要重新确认</strong>
              <p>{props.errorMessage ?? '家人刚刚改动了这批库存，请重新选择后再提交。'}</p>
            </div>
          ) : null}

          {errorText && conflictState !== 'review_again' ? (
            <div className="inventory-action-error" role="alert">
              {errorText}
            </div>
          ) : null}

          {showsBatchList ? (
            <>
              <section className="card inventory-action-summary-card">
                <div className="inventory-action-summary-copy">
                  <p className="eyebrow">处理中的食材</p>
                  <h4>{group.ingredientName}</h4>
                  <p className="subtle">{group.detail}</p>
                </div>
                <div className="inventory-action-summary-metrics">
                  <article>
                    <span>已过期</span>
                    <strong>{expiredBatches.length}</strong>
                    <em>{isPresenceGroup(group) ? '项' : '批'}</em>
                  </article>
                  <article>
                    <span>即将到期</span>
                    <strong>{upcomingBatches.length}</strong>
                    <em>{isPresenceGroup(group) ? '项' : '批'}</em>
                  </article>
                  <article>
                    <span>已选</span>
                    <strong>{selectedValidCount}</strong>
                    <em>{isPresenceGroup(group) ? '项' : '批'}</em>
                  </article>
                </div>
              </section>

              {mode.kind === 'review' || mode.kind === 'snooze' ? (
                <section className="inventory-action-intent-panel" aria-labelledby="inventory-action-intent-title">
                  <div className="inventory-action-intent-copy">
                    <span id="inventory-action-intent-title">处理方式</span>
                    <p>
                      {hasExpired
                        ? '销毁不能继续使用的批次，仍可使用的可以暂时保留。'
                        : '设置下一次提醒，不会修改原到期日。'}
                    </p>
                  </div>
                  <OptionChipGroup
                    ariaLabel="库存处理方式"
                    value={handlingIntent}
                    size="medium"
                    className="inventory-action-intent-options"
                    options={handlingOptions}
                    onChange={(value) => {
                      if (value === 'dispose') {
                        selectDisposeIntent();
                        return;
                      }
                      if (value === 'retain') {
                        enterRetainExpired();
                        return;
                      }
                      enterSnoozeUpcoming();
                    }}
                  />
                </section>
              ) : null}

              {mode.kind === 'snooze' ? (
                <section className="card inventory-action-snooze-panel">
                  <div className="inventory-action-field-head">
                    <span>再次提醒日期</span>
                    <p className="subtle">
                      {mode.audience === 'expired'
                        ? '原到期日仍会显示；你确认暂时可用后，系统只负责再次提醒。'
                        : '不会把未过期批次记成过期审核，只推迟提醒。'}
                    </p>
                  </div>
                  <OptionChipGroup
                    ariaLabel="提醒预设"
                    value={snoozePreset}
                    size="large"
                    className="inventory-action-snooze-presets"
                    onChange={(value) => {
                      if (busy) return;
                      setSnoozePreset(value);
                      setLocalError(null);
                    }}
                    options={[
                      { value: 'tomorrow', label: '明天', description: formatDate(tomorrowKey) },
                      { value: 'three_days', label: '3 天后', description: formatDate(threeDaysKey) },
                      { value: 'custom', label: '自定义日期' },
                    ]}
                  />
                  {snoozePreset === 'custom' ? (
                    <label className="inventory-action-date-field">
                      <span>自定义日期</span>
                      <input
                        type="date"
                        name="custom-snooze-date"
                        min={tomorrowKey}
                        max={maxSnoozeKey}
                        value={customSnoozeDate}
                        disabled={busy}
                        onChange={(event) => setCustomSnoozeDate(event.target.value)}
                      />
                    </label>
                  ) : (
                    <input
                      type="date"
                      name="custom-snooze-date"
                      min={tomorrowKey}
                      max={maxSnoozeKey}
                      value={customSnoozeDate}
                      disabled={busy}
                      hidden
                      onChange={(event) => setCustomSnoozeDate(event.target.value)}
                    />
                  )}
                </section>
              ) : null}

              {(() => {
                const expiredForList =
                  mode.kind === 'dispose_confirm'
                    ? expiredBatches.filter((batch) => selectedIds.includes(batch.inventoryItemId))
                    : expiredBatches;
                const upcomingForList = mode.kind === 'dispose_confirm' ? [] : upcomingBatches;
                return (
                  <>
                    {expiredForList.length > 0 ? (
                      <BatchSection
                        title={isPresenceGroup(group) ? "已过期" : "已过期批次"}
                        count={expiredForList.length}
                        batches={expiredForList}
                        selectedIds={selectedIds}
                        validIds={validIds}
                        busy={busy}
                        showCorrect={mode.kind === 'review'}
                        onToggle={toggleBatch}
                        onCorrect={enterCorrectDate}
                      />
                    ) : null}
                    {upcomingForList.length > 0 ? (
                      <BatchSection
                        title={isPresenceGroup(group) ? "即将到期" : "即将到期批次"}
                        count={upcomingForList.length}
                        batches={upcomingForList}
                        selectedIds={selectedIds}
                        validIds={validIds}
                        busy={busy}
                        showCorrect={mode.kind === 'review'}
                        onToggle={toggleBatch}
                        onCorrect={enterCorrectDate}
                      />
                    ) : null}
                  </>
                );
              })()}
            </>
          ) : null}

          {mode.kind === 'correct_date' ? (
            <CorrectDatePanel
              group={group}
              inventoryItemId={mode.inventoryItemId}
              value={correctedExpiryDate}
              busy={busy}
              onChange={setCorrectedExpiryDate}
            />
          ) : null}
        </div>
      </WorkspaceModal>
    </WorkspaceOverlayFrame>
  );
}

function BatchSection(props: {
  title: string;
  count: number;
  batches: InventoryActionBatch[];
  selectedIds: string[];
  validIds: Set<string>;
  busy: boolean;
  showCorrect: boolean;
  onToggle: (inventoryItemId: string) => void;
  onCorrect: (inventoryItemId: string) => void;
}) {
  return (
    <section className="card inventory-action-batch-section">
      <div className="inventory-action-field-head inventory-action-batch-section-head">
        <span>{props.title}</span>
        <em>{props.count}{props.batches.some((b) => b.presenceOnly) ? " 项" : " 批"}</em>
      </div>
      <div className="inventory-action-batch-list">
        {props.batches.map((batch) => {
          const selectable = props.validIds.has(batch.inventoryItemId);
          const checked = props.selectedIds.includes(batch.inventoryItemId);
          const review = priorReviewCopy(batch);
          const quantityLabel = batch.presenceOnly
            ? '只记录整体有无'
            : `${formatQuantityValue(batch.remainingQuantity)} ${batch.unit}`.trim();
          return (
            <article
              key={batch.inventoryItemId}
              className={[
                'inventory-action-batch-row',
                selectable ? '' : 'is-disabled',
                checked && selectable ? 'is-selected' : '',
                isExpiredBatch(batch) ? 'is-expired' : 'is-upcoming',
              ]
                .filter(Boolean)
                .join(' ')}
            >
              <label className="inventory-action-batch-main">
                <input
                  type="checkbox"
                  className="inventory-action-checkbox"
                  value={batch.inventoryItemId}
                  aria-label={`选择 ${quantityLabel || '数量未登记'}，${batch.storageLocation || '未标注位置'}，${batchStatusCopy(batch)}`}
                  checked={checked && selectable}
                  disabled={props.busy || !selectable}
                  onChange={() => props.onToggle(batch.inventoryItemId)}
                />
                <div className="inventory-action-batch-copy">
                  <div className="inventory-action-batch-title-row">
                    <strong>{quantityLabel || '数量未登记'}</strong>
                    <span className="inventory-action-batch-location">{batch.storageLocation || '未标注位置'}</span>
                    <StatusBadge
                      tone={isExpiredBatch(batch) ? 'danger' : 'warning'}
                      size="compact"
                    >
                      {batchStatusCopy(batch)}
                    </StatusBadge>
                  </div>
                  <div className="inventory-action-batch-meta">
                    {batch.purchaseDate ? (
                      <>
                        <span>购 {compactDateLabel(batch.purchaseDate)}</span>
                        <span aria-hidden="true">·</span>
                      </>
                    ) : null}
                    <span>原到期 {compactDateLabel(batch.expiryDate)}</span>
                  </div>
                  {review ? (
                    <div className="inventory-action-batch-review">
                      <strong>{review.title}</strong>
                      <p>{review.detail}</p>
                    </div>
                  ) : null}
                </div>
              </label>
              {props.showCorrect ? (
                <ActionButton
                  tone="secondary"
                  size="compact"
                  type="button"
                  className="inventory-action-correct-button"
                  disabled={props.busy}
                  onClick={() => props.onCorrect(batch.inventoryItemId)}
                >
                  修正日期
                </ActionButton>
              ) : null}
            </article>
          );
        })}
      </div>
    </section>
  );
}

function CorrectDatePanel(props: {
  group: ExpiryInventoryActionGroup;
  inventoryItemId: string;
  value: string;
  busy: boolean;
  onChange: (value: string) => void;
}) {
  const target = props.group.batches.find((batch) => batch.inventoryItemId === props.inventoryItemId);
  if (!target) {
    return (
      <div className="inventory-action-error" role="alert">
        找不到要更正的批次。
      </div>
    );
  }

  return (
    <section className="card inventory-action-correct-panel">
      <div className="card inventory-action-summary-card">
        <div>
          <p className="eyebrow">单批更正</p>
          <h4>{props.group.ingredientName}</h4>
          <p className="subtle">
            {formatQuantityValue(target.remainingQuantity)} {target.unit} · {target.storageLocation || '未标注位置'}
          </p>
        </div>
        <div className="inventory-action-batch-meta">
          <span>原到期日 {compactDateLabel(target.expiryDate)}</span>
        </div>
      </div>
      <label className="inventory-action-date-field">
        <span>更正后的到期日</span>
        <input
          type="date"
          name="corrected-expiry-date"
          value={props.value}
          disabled={props.busy}
          onChange={(event) => props.onChange(event.target.value)}
        />
      </label>
    </section>
  );
}
