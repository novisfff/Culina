import { useMemo, useState } from 'react';

import { asText } from './aiDraftValueUtils';
import {
  groupInventoryIntakeItems,
  intakeDateSourceLabel,
  inventoryIntakeActionOptions,
  inventoryIntakeDraftFromRecord,
  inventoryIntakeItemSummary,
  inventoryIntakeNeedsAttention,
  inventoryIntakeSubmitSummary,
  patchInventoryIntakeDate,
  patchInventoryIntakeItem,
  type InventoryIntakeDraft,
  type InventoryIntakeDraftItem,
  type InventoryIntakeEditableItemPatch,
  type InventoryIntakePackageConversion,
  type InventoryIntakeSourceKind,
} from './aiInventoryIntakeDraftModel';

type DraftRecord = Record<string, unknown>;

type AiInventoryIntakeApprovalProps = {
  draft: DraftRecord | InventoryIntakeDraft;
  readonly?: boolean;
  onChange: (draft: InventoryIntakeDraft) => void;
};

function quantityInputValue(value: string | number | null | undefined) {
  if (value === null || value === undefined) return '';
  return String(value);
}

function isQuantityTarget(item: InventoryIntakeDraftItem) {
  return (item.action === 'stock_and_fulfill' || item.action === 'stock_only')
    && (item.targetKind === 'exact_ingredient' || item.targetKind === 'food');
}

function isPresenceTarget(item: InventoryIntakeDraftItem) {
  return (item.action === 'stock_and_fulfill' || item.action === 'stock_only')
    && item.targetKind === 'presence_ingredient';
}

function isStockAction(item: InventoryIntakeDraftItem) {
  return item.action === 'stock_and_fulfill' || item.action === 'stock_only';
}

function InventoryIntakeRow({
  item,
  intakeDate,
  readonly,
  expanded,
  onToggle,
  onPatch,
}: {
  item: InventoryIntakeDraftItem;
  intakeDate: string;
  readonly: boolean;
  expanded: boolean;
  onToggle: () => void;
  onPatch: (patch: InventoryIntakeEditableItemPatch) => void;
}) {
  const title = item.title.trim() || '未命名入库项';
  const needsAttention = inventoryIntakeNeedsAttention(item, intakeDate);
  const sourceKind = (item.sourceKind || 'direct') as InventoryIntakeSourceKind;
  const actionOptions = item.sourceKind
    ? inventoryIntakeActionOptions(sourceKind)
    : inventoryIntakeActionOptions('direct');
  const conversion = item.packageConversion;
  const showStockFields = isStockAction(item);

  const updateConversion = (patch: Partial<InventoryIntakePackageConversion>) => {
    const current = conversion && typeof conversion === 'object' ? conversion : {
      ratio: null,
      targetUnit: '',
      evidence: '',
    };
    onPatch({ packageConversion: { ...current, ...patch } });
  };

  return (
    <article className={`ai-inventory-intake-row${needsAttention ? ' needs-attention' : ''}`}>
      <button
        type="button"
        className="ai-inventory-intake-row-toggle"
        aria-expanded={expanded}
        onClick={onToggle}
      >
        <span className="ai-inventory-intake-row-copy">
          <strong>{title}</strong>
          <small>{inventoryIntakeItemSummary(item)}</small>
        </span>
        <span className={`ai-inventory-intake-badge${needsAttention ? ' needs-attention' : ' is-ready'}`}>
          {needsAttention ? '需补充' : '已就绪'}
        </span>
        <span className="ai-inventory-intake-chevron" aria-hidden="true">⌄</span>
      </button>

      {expanded ? (
        <div className="ai-inventory-intake-row-body">
          {item.sourceText ? (
            <p className="ai-inventory-intake-source-text">{item.sourceText}</p>
          ) : null}

          <label className="ai-inventory-intake-field">
            <span>处理方式</span>
            <select
              className="text-input"
              value={item.action || ''}
              disabled={readonly || !item.sourceKind}
              onChange={(event) => onPatch({ action: event.target.value as InventoryIntakeDraftItem['action'] })}
            >
              {actionOptions.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          </label>

          {isQuantityTarget(item) ? (
            <div className="ai-inventory-intake-quantity-grid">
              <label className="ai-inventory-intake-field">
                <span>实际入库数量</span>
                <input
                  className="text-input"
                  type="number"
                  min="0"
                  step="any"
                  aria-label={`${title}实际入库数量`}
                  value={quantityInputValue(item.enteredQuantity)}
                  disabled={readonly}
                  onChange={(event) => onPatch({ enteredQuantity: event.target.value })}
                />
              </label>
              <label className="ai-inventory-intake-field">
                <span>单位</span>
                <input
                  className="text-input"
                  aria-label={`${title}实际入库单位`}
                  value={asText(item.enteredUnit)}
                  disabled={readonly}
                  onChange={(event) => onPatch({ enteredUnit: event.target.value })}
                />
              </label>
            </div>
          ) : null}

          {isPresenceTarget(item) ? (
            <label className="ai-inventory-intake-field">
              <span>入库后的库存状态</span>
              <select
                className="text-input"
                value={asText(item.resultingAvailabilityLevel, 'sufficient')}
                disabled={readonly}
                onChange={(event) => onPatch({ resultingAvailabilityLevel: event.target.value })}
              >
                <option value="sufficient">充足</option>
                <option value="present_unknown">还在，数量不确定</option>
                <option value="low">少量</option>
              </select>
            </label>
          ) : null}

          {conversion && showStockFields && item.targetKind !== 'presence_ingredient' ? (
            <section className="ai-inventory-intake-conversion" aria-label={`${title}包装换算`}>
              <strong>一次性包装换算</strong>
              <div className="ai-inventory-intake-quantity-grid">
                <label className="ai-inventory-intake-field">
                  <span>每份换算倍率</span>
                  <input
                    className="text-input"
                    type="number"
                    min="0"
                    step="any"
                    value={quantityInputValue(conversion.ratio)}
                    disabled={readonly}
                    onChange={(event) => updateConversion({ ratio: event.target.value })}
                  />
                </label>
                <label className="ai-inventory-intake-field">
                  <span>入库目标单位</span>
                  <input
                    className="text-input"
                    value={asText(conversion.targetUnit)}
                    disabled={readonly}
                    onChange={(event) => updateConversion({ targetUnit: event.target.value })}
                  />
                </label>
              </div>
              <label className="ai-inventory-intake-field">
                <span>换算证据</span>
                <input
                  className="text-input"
                  value={asText(conversion.evidence)}
                  disabled={readonly}
                  onChange={(event) => updateConversion({ evidence: event.target.value })}
                />
              </label>
            </section>
          ) : null}

          {showStockFields ? (
            <div className="ai-inventory-intake-advanced-grid">
              <label className="ai-inventory-intake-field">
                <span>存放位置</span>
                <input
                  className="text-input"
                  value={asText(item.storageLocation)}
                  disabled={readonly}
                  onChange={(event) => onPatch({ storageLocation: event.target.value })}
                />
              </label>
              <label className="ai-inventory-intake-field">
                <span>到期日</span>
                <input
                  className="text-input"
                  type="date"
                  value={asText(item.expiryDate)}
                  disabled={readonly}
                  onChange={(event) => onPatch({ expiryDate: event.target.value || null })}
                />
              </label>
              {item.targetKind !== 'food' && item.targetKind !== 'presence_ingredient' ? (
                <label className="ai-inventory-intake-field">
                  <span>库存状态</span>
                  <select
                    className="text-input"
                    value={asText(item.inventoryStatus, 'fresh')}
                    disabled={readonly}
                    onChange={(event) => onPatch({ inventoryStatus: event.target.value })}
                  >
                    <option value="fresh">新鲜</option>
                    <option value="opened">已开封</option>
                    <option value="frozen">冷冻</option>
                    <option value="expiring">临期</option>
                  </select>
                </label>
              ) : null}
              <label className="ai-inventory-intake-field ai-inventory-intake-notes">
                <span>备注</span>
                <textarea
                  className="text-input"
                  rows={2}
                  value={asText(item.notes)}
                  disabled={readonly}
                  onChange={(event) => onPatch({ notes: event.target.value })}
                />
              </label>
            </div>
          ) : (
            <label className="ai-inventory-intake-field ai-inventory-intake-notes">
              <span>备注</span>
              <textarea
                className="text-input"
                rows={2}
                value={asText(item.notes)}
                disabled={readonly}
                onChange={(event) => onPatch({ notes: event.target.value })}
              />
            </label>
          )}
        </div>
      ) : null}
    </article>
  );
}

export function AiInventoryIntakeApproval({
  draft: rawDraft,
  readonly = false,
  onChange,
}: AiInventoryIntakeApprovalProps) {
  const draft = inventoryIntakeDraftFromRecord(rawDraft as Record<string, unknown>);
  const groups = groupInventoryIntakeItems(draft);
  const attentionIds = useMemo(
    () => new Set(
      draft.items
        .filter((item) => inventoryIntakeNeedsAttention(item, draft.intakeDate))
        .map((item) => item.lineId)
        .filter(Boolean),
    ),
    [draft],
  );
  const [expandedIds, setExpandedIds] = useState<Set<string>>(() => new Set(attentionIds));

  const toggleExpanded = (lineId: string) => {
    setExpandedIds((current) => {
      const next = new Set(current);
      if (next.has(lineId)) next.delete(lineId);
      else next.add(lineId);
      return next;
    });
  };

  const handleItemPatch = (lineId: string, patch: InventoryIntakeEditableItemPatch) => {
    onChange(patchInventoryIntakeItem(draft, lineId, patch));
  };

  const handleDateChange = (intakeDate: string) => {
    onChange(patchInventoryIntakeDate(draft, intakeDate));
  };

  return (
    <section className="ai-inventory-intake-editor" aria-label="确认入库内容">
      <header className="ai-inventory-intake-overview" aria-label="本次入库概览">
        <div className="ai-inventory-intake-overview-main">
          <label className="ai-inventory-intake-field ai-inventory-intake-date-field">
            <span>入库日期</span>
            <input
              className="text-input"
              type="date"
              value={draft.intakeDate}
              disabled={readonly}
              onChange={(event) => handleDateChange(event.target.value)}
            />
          </label>
          <span className="ai-inventory-intake-source-badge">{intakeDateSourceLabel(String(draft.intakeDateSource))}</span>
        </div>
        <div className="ai-inventory-intake-overview-counts">
          <span>
            <strong>{groups.shopping.length + groups.direct.length}</strong>
            项入库
          </span>
          {groups.ignored.length > 0 ? (
            <span>
              <strong>{groups.ignored.length}</strong>
              项忽略
            </span>
          ) : null}
        </div>
        <div className={`ai-inventory-intake-readiness${attentionIds.size > 0 ? ' needs-attention' : ' is-ready'}`}>
          <span className="ai-inventory-intake-readiness-dot" aria-hidden="true" />
          <span>
            <strong>
              {attentionIds.size > 0
                ? `${attentionIds.size} 项需要补充`
                : '信息完整，可以确认'}
            </strong>
            <small>
              {attentionIds.size > 0
                ? '补齐标记项后即可统一入库'
                : '确认后统一登记库存'}
            </small>
          </span>
        </div>
      </header>

      <div className="ai-inventory-intake-groups" aria-label="入库项清单">
        {groups.shopping.length > 0 ? (
          <section className="ai-inventory-intake-group" aria-label="采购清单关联">
            <header className="ai-inventory-intake-group-header">
              <span>
                <strong>采购清单关联</strong>
                <small>入库后同步完成对应采购项</small>
              </span>
              <em>{groups.shopping.length} 项</em>
            </header>
            <div className="ai-inventory-intake-group-list">
              {groups.shopping.map((item) => (
                <InventoryIntakeRow
                  key={item.lineId}
                  item={item}
                  intakeDate={draft.intakeDate}
                  readonly={readonly}
                  expanded={expandedIds.has(item.lineId)}
                  onToggle={() => toggleExpanded(item.lineId)}
                  onPatch={(patch) => handleItemPatch(item.lineId, patch)}
                />
              ))}
            </div>
          </section>
        ) : null}

        {groups.direct.length > 0 ? (
          <section className="ai-inventory-intake-group" aria-label="直接入库">
            <header className="ai-inventory-intake-group-header">
              <span>
                <strong>直接入库</strong>
                <small>只增加库存，不创建或完成采购项</small>
              </span>
              <em>{groups.direct.length} 项</em>
            </header>
            <div className="ai-inventory-intake-group-list">
              {groups.direct.map((item) => (
                <InventoryIntakeRow
                  key={item.lineId}
                  item={item}
                  intakeDate={draft.intakeDate}
                  readonly={readonly}
                  expanded={expandedIds.has(item.lineId)}
                  onToggle={() => toggleExpanded(item.lineId)}
                  onPatch={(patch) => handleItemPatch(item.lineId, patch)}
                />
              ))}
            </div>
          </section>
        ) : null}
      </div>

      {groups.ignored.length > 0 ? (
        <details className="ai-inventory-intake-ignored" aria-label="已忽略">
          <summary>
            <span>
              <strong>已忽略</strong>
              <small>不会写入库存，无需确认</small>
            </span>
            <em>{groups.ignored.length} 项</em>
          </summary>
          <ul>
            {groups.ignored.map((item, index) => (
              <li key={item.sourceLineId || `ignored-${index}`}>
                <strong>{item.displayName || item.sourceText || '已忽略项'}</strong>
                <span>{item.reason || '本次不会入库'}</span>
              </li>
            ))}
          </ul>
        </details>
      ) : null}

      <footer className="ai-inventory-intake-submit-summary">
        <span>确认后将</span>
        <strong>{inventoryIntakeSubmitSummary(draft)}</strong>
      </footer>
    </section>
  );
}

export { validateInventoryIntakeDraftForSubmit } from './aiInventoryIntakeDraftModel';
