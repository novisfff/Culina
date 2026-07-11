import { useEffect, useMemo, useState, type ReactNode } from 'react';
import type { VersionedInventoryItemRef } from '../../api/types';
import { FormActions, OptionChipGroup, WorkspaceModal, WorkspaceOverlayFrame } from '../../components/ui-kit';
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

function priorReviewCopy(batch: InventoryActionBatch) {
  if (batch.expiryReviewedAt) {
    const when = formatDateTime(batch.expiryReviewedAt);
    if (batch.expiryAlertSnoozedUntil) {
      return {
        title: '此前已确认暂时保留',
        detail: `原到期日仍保留，将于 ${formatDate(batch.expiryAlertSnoozedUntil)} 再次提醒 · ${when}`,
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
      detail: `将于 ${formatDate(batch.expiryAlertSnoozedUntil)} 再次提醒`,
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
  // Default review: only expired rows are actionable until the user chooses future snooze.
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

  function handleDisposeIntent() {
    if (busy) return;
    if (!hasExpired) {
      setLocalError('当前没有可销毁的过期批次。');
      return;
    }
    if (mode.kind === 'review' && mode.focus === 'dispose') {
      setMode({ kind: 'dispose_confirm' });
      return;
    }
    applyAudienceSelection('expired');
    setMode({ kind: 'review', focus: 'dispose' });
  }

  function enterRetainExpired() {
    if (busy) return;
    applyAudienceSelection('expired');
    setSnoozePreset('tomorrow');
    setCustomSnoozeDate('');
    setMode({ kind: 'snooze', audience: 'expired' });
  }

  function enterSnoozeUpcoming() {
    if (busy) return;
    applyAudienceSelection('upcoming');
    setSnoozePreset('tomorrow');
    setCustomSnoozeDate('');
    setMode({ kind: 'snooze', audience: 'upcoming' });
  }

  function enterCorrectDate(inventoryItemId: string) {
    if (busy) return;
    const target = group.batches.find((batch) => batch.inventoryItemId === inventoryItemId);
    setMode({ kind: 'correct_date', inventoryItemId });
    setCorrectedExpiryDate(target?.expiryDate.slice(0, 10) ?? props.referenceDate);
    setLocalError(null);
  }

  function toggleBatch(inventoryItemId: string) {
    if (busy) return;
    if (!validIds.has(inventoryItemId)) return;
    setSelectedIds((current) =>
      current.includes(inventoryItemId)
        ? current.filter((id) => id !== inventoryItemId)
        : [...current, inventoryItemId],
    );
  }

  function resolveSnoozeDate() {
    if (snoozePreset === 'tomorrow') return tomorrowKey;
    if (snoozePreset === 'three_days') return threeDaysKey;
    return customSnoozeDate;
  }

  function isValidSnoozeDate(value: string) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    return value > props.referenceDate && value <= maxSnoozeKey;
  }

  async function submitDispose() {
    if (busy) return;
    const allowed = new Set(validIdsForAudience(group, 'expired'));
    const items = toVersionedRefs(group, selectedIds).filter((item) => allowed.has(item.inventory_item_id));
    if (items.length === 0) {
      setLocalError('请先选择要销毁的过期批次。');
      return;
    }
    setLocalError(null);
    try {
      await props.onDispose(items);
    } catch {
      // Parent retains dialog and surfaces conflict/error state.
    }
  }

  async function submitSnooze() {
    if (busy || mode.kind !== 'snooze') return;
    const snoozedUntil = resolveSnoozeDate();
    if (!isValidSnoozeDate(snoozedUntil)) {
      setLocalError(`提醒日期需晚于今天，且不超过 ${formatDate(maxSnoozeKey)}。`);
      return;
    }
    const allowed = new Set(validIdsForAudience(group, mode.audience));
    const items = toVersionedRefs(group, selectedIds).filter((item) => allowed.has(item.inventory_item_id));
    if (items.length === 0) {
      setLocalError(mode.audience === 'expired' ? '请先选择要暂时保留的过期批次。' : '请先选择要稍后提醒的批次。');
      return;
    }
    setLocalError(null);
    try {
      await props.onSnooze({
        action: mode.audience === 'expired' ? 'retain_expired' : 'snooze_upcoming',
        items,
        snoozedUntil,
      });
    } catch {
      // Parent retains dialog and surfaces conflict/error state.
    }
  }

  async function submitCorrection() {
    if (busy || mode.kind !== 'correct_date') return;
    const target = group.batches.find((batch) => batch.inventoryItemId === mode.inventoryItemId);
    if (!target) {
      setLocalError('找不到要更正的批次。');
      return;
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(correctedExpiryDate)) {
      setLocalError('请填写有效的到期日。');
      return;
    }
    setLocalError(null);
    try {
      await props.onCorrectExpiry({
        inventoryItemId: target.inventoryItemId,
        expectedRowVersion: target.rowVersion,
        expiryDate: correctedExpiryDate,
      });
    } catch {
      // Parent retains dialog and surfaces conflict/error state.
    }
  }

  const title =
    mode.kind === 'dispose_confirm'
      ? '确认销毁'
      : mode.kind === 'snooze'
        ? mode.audience === 'expired'
          ? '暂时保留'
          : '稍后提醒'
        : mode.kind === 'correct_date'
          ? '更正到期日'
          : group.title;

  const description =
    mode.kind === 'dispose_confirm'
      ? '销毁后剩余量会清零，历史记录会保留。'
      : mode.kind === 'snooze' && mode.audience === 'expired'
        ? '原到期日会继续保留。由你决定暂时可用，系统只负责再次提醒。'
        : mode.kind === 'snooze'
          ? '仅推迟提醒，不会改写到期日或记为过期审核。'
          : mode.kind === 'correct_date'
            ? '更正录错的到期日。此前的暂时保留状态会一并清除。'
            : group.detail;

  const errorText = localError ?? props.errorMessage ?? null;

  const footerInfo = (
    <div className="inventory-action-footer-summary">
      <span>{mode.kind === 'dispose_confirm' ? '将销毁' : '已选择'}</span>
      <strong>
        {selectedValidCount} 个批次
        {selectedQuantityLabels.length > 0 ? ` · ${selectedQuantityLabels.join('、')}` : ''}
      </strong>
      {mode.kind === 'dispose_confirm' ? (
        <p>
          {group.ingredientName} · {selectedValidCount} 批 · {selectedQuantityLabels.join('、') || '无数量'}
        </p>
      ) : (
        <p>{group.ingredientName}</p>
      )}
    </div>
  );

  let footerActions: ReactNode;

  if (mode.kind === 'dispose_confirm') {
    footerActions = (
      <FormActions
        className="inventory-action-actions"
        primaryLabel="确认销毁"
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
        className="inventory-action-actions"
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
        className="inventory-action-actions"
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
        className="inventory-action-actions"
        primaryLabel={hasExpired ? '销毁所选批次' : '关闭'}
        primaryTone={hasExpired ? 'danger' : 'primary'}
        isSubmitting={busy}
        primaryDisabled={busy || (hasExpired && selectedValidCount === 0)}
        onPrimary={() => {
          if (hasExpired) {
            handleDisposeIntent();
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
      rootClassName={['inventory-action-overlay-root', props.overlayRootClassName].filter(Boolean).join(' ')}
      closeOnBackdrop={!busy}
      onClose={closeIfAllowed}
    >
      <WorkspaceModal
        title={title}
        description={description}
        closeLabel="关闭"
        closeAriaLabel="关闭"
        className="workspace-modal-wide inventory-action-modal"
        onClose={closeIfAllowed}
        footerInfo={footerInfo}
        footerActions={footerActions}
      >
        <div className="inventory-action-scroll">
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
              <section className="inventory-action-summary-card">
                <div>
                  <p className="eyebrow">处理中的食材</p>
                  <h4>{group.ingredientName}</h4>
                  <p className="subtle">{group.detail}</p>
                </div>
                <div className="inventory-action-summary-metrics">
                  <article>
                    <span>已过期</span>
                    <strong>{expiredBatches.length} 批</strong>
                  </article>
                  <article>
                    <span>即将到期</span>
                    <strong>{upcomingBatches.length} 批</strong>
                  </article>
                </div>
              </section>

              {mode.kind === 'review' || mode.kind === 'snooze' ? (
                <section className="inventory-action-intent-row" aria-label="处理动作">
                  {hasExpired ? (
                    <>
                      <button
                        type="button"
                        className={[
                          'inventory-action-intent',
                          mode.kind === 'review' && mode.focus === 'dispose' ? 'is-active' : '',
                        ]
                          .filter(Boolean)
                          .join(' ')}
                        disabled={busy}
                        onClick={handleDisposeIntent}
                      >
                        销毁所选批次
                      </button>
                      <button
                        type="button"
                        className={[
                          'inventory-action-intent',
                          mode.kind === 'snooze' && mode.audience === 'expired' ? 'is-active' : '',
                        ]
                          .filter(Boolean)
                          .join(' ')}
                        disabled={busy}
                        onClick={enterRetainExpired}
                      >
                        暂时保留
                      </button>
                    </>
                  ) : null}
                  {hasUpcoming ? (
                    <button
                      type="button"
                      className={[
                        'inventory-action-intent',
                        mode.kind === 'snooze' && mode.audience === 'upcoming' ? 'is-active' : '',
                      ]
                        .filter(Boolean)
                        .join(' ')}
                      disabled={busy}
                      onClick={enterSnoozeUpcoming}
                    >
                      稍后提醒
                    </button>
                  ) : null}
                </section>
              ) : null}

              {mode.kind === 'snooze' ? (
                <section className="inventory-action-snooze-panel">
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
                    // Keep the control present for bound checks even when preset is not custom;
                    // hidden field still exposes min/max for tests and a11y tooling.
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
                        title="已过期批次"
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
                        title="即将到期批次"
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
  batches: InventoryActionBatch[];
  selectedIds: string[];
  validIds: Set<string>;
  busy: boolean;
  showCorrect: boolean;
  onToggle: (inventoryItemId: string) => void;
  onCorrect: (inventoryItemId: string) => void;
}) {
  return (
    <section className="inventory-action-batch-section">
      <div className="inventory-action-field-head">
        <span>{props.title}</span>
      </div>
      <div className="inventory-action-batch-list">
        {props.batches.map((batch) => {
          const selectable = props.validIds.has(batch.inventoryItemId);
          const checked = props.selectedIds.includes(batch.inventoryItemId);
          const review = priorReviewCopy(batch);
          return (
            <article
              key={batch.inventoryItemId}
              className={[
                'inventory-action-batch-row',
                selectable ? '' : 'is-disabled',
                isExpiredBatch(batch) ? 'is-expired' : 'is-upcoming',
              ]
                .filter(Boolean)
                .join(' ')}
            >
              <label className="inventory-action-batch-main">
                <input
                  type="checkbox"
                  value={batch.inventoryItemId}
                  checked={checked && selectable}
                  disabled={props.busy || !selectable}
                  onChange={() => props.onToggle(batch.inventoryItemId)}
                />
                <div>
                  <strong>
                    {formatQuantityValue(batch.remainingQuantity)} {batch.unit}
                  </strong>
                  <span>{batch.storageLocation || '未标注位置'}</span>
                </div>
              </label>
              <div className="inventory-action-batch-meta">
                <span className={isExpiredBatch(batch) ? 'is-danger' : 'is-warning'}>{batchStatusCopy(batch)}</span>
                <span>购 {formatDate(batch.purchaseDate)}</span>
                <span>原到期日 {formatDate(batch.expiryDate)}</span>
              </div>
              {review ? (
                <div className="inventory-action-batch-review">
                  <strong>{review.title}</strong>
                  <p>{review.detail}</p>
                </div>
              ) : null}
              {props.showCorrect ? (
                <button
                  type="button"
                  className="inventory-action-correct-button"
                  disabled={props.busy}
                  onClick={() => props.onCorrect(batch.inventoryItemId)}
                >
                  日期录错了
                </button>
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
    <section className="inventory-action-correct-panel">
      <div className="inventory-action-summary-card">
        <div>
          <p className="eyebrow">单批更正</p>
          <h4>{props.group.ingredientName}</h4>
          <p className="subtle">
            {formatQuantityValue(target.remainingQuantity)} {target.unit} · {target.storageLocation || '未标注位置'}
          </p>
        </div>
        <div className="inventory-action-batch-meta">
          <span>原到期日 {formatDate(target.expiryDate)}</span>
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
