import { useMemo, useState } from 'react';

import { ApprovalSelectField } from './AiApprovalFields';
import { asText } from './aiDraftValueUtils';
import { AiDraftImpactNote } from './draft-ui/AiDraftImpactNote';
import { AiDraftSection } from './draft-ui/AiDraftSection';
import { AiDraftSummaryCard } from './draft-ui/AiDraftSummaryCard';
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

const PRESENCE_LEVEL_OPTIONS = [
  { value: 'sufficient', label: '充足' },
  { value: 'present_unknown', label: '还在，数量不确定' },
  { value: 'low', label: '少量' },
];

const INVENTORY_STATUS_OPTIONS = [
  { value: 'fresh', label: '新鲜' },
  { value: 'opened', label: '已开封' },
  { value: 'frozen', label: '冷冻' },
  { value: 'expiring', label: '临期' },
];

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

          <ApprovalSelectField
            label="处理方式"
            value={item.action || ''}
            disabled={readonly || !item.sourceKind}
            options={actionOptions}
            icon="type"
            className="ai-inventory-intake-field"
            onChange={(action) => onPatch({ action: action as InventoryIntakeDraftItem['action'] })}
          />

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
            <ApprovalSelectField
              label="入库后的库存状态"
              value={asText(item.resultingAvailabilityLevel, 'sufficient')}
              disabled={readonly}
              options={PRESENCE_LEVEL_OPTIONS}
              icon="type"
              className="ai-inventory-intake-field"
              onChange={(resultingAvailabilityLevel) => onPatch({ resultingAvailabilityLevel })}
            />
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
                <ApprovalSelectField
                  label="库存状态"
                  value={asText(item.inventoryStatus, 'fresh')}
                  disabled={readonly}
                  options={INVENTORY_STATUS_OPTIONS}
                  icon="type"
                  className="ai-inventory-intake-field"
                  onChange={(inventoryStatus) => onPatch({ inventoryStatus })}
                />
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

  const activeCount = groups.shopping.length + groups.direct.length;
  const attentionItems = draft.items.filter((item) => inventoryIntakeNeedsAttention(item, draft.intakeDate));
  const overviewItems = [
    { label: '入库日期', value: draft.intakeDate || '未填写' },
    { label: '日期来源', value: intakeDateSourceLabel(String(draft.intakeDateSource)) },
    { label: '待处理', value: `${activeCount} 项` },
    { label: '采购关联', value: `${groups.shopping.length} 项` },
    { label: '直接入库', value: `${groups.direct.length} 项` },
    { label: '已忽略', value: `${groups.ignored.length} 项` },
  ];

  return (
    <section className="ai-inventory-intake-editor" aria-label="确认入库内容">
      <AiDraftSummaryCard
        title="本次入库概览"
        items={overviewItems}
        className="ai-inventory-intake-overview ai-inventory-intake-summary-card"
      >
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
      </AiDraftSummaryCard>

      {attentionItems.length > 0 ? (
        <AiDraftImpactNote tone="warning" title="还需补充" className="ai-inventory-intake-attention">
          <p>{attentionItems.map((item) => item.title || item.sourceText || '未命名入库项').join('、')} 仍缺少入库信息。</p>
          <p>补齐标记项后即可统一入库。</p>
        </AiDraftImpactNote>
      ) : null}

      <div className="ai-inventory-intake-groups" aria-label="入库项清单">
        {groups.shopping.length > 0 ? (
          <AiDraftSection
            title="采购清单关联"
            description="入库后同步完成对应采购项。"
            action={<span className="ai-inventory-intake-group-count">{groups.shopping.length} 项</span>}
            className="ai-confirmation-item ai-inventory-intake-group"
          >
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
          </AiDraftSection>
        ) : null}

        {groups.direct.length > 0 ? (
          <AiDraftSection
            title="直接入库"
            description="只增加库存，不创建或完成采购项。"
            action={<span className="ai-inventory-intake-group-count">{groups.direct.length} 项</span>}
            className="ai-confirmation-item ai-inventory-intake-group"
          >
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
          </AiDraftSection>
        ) : null}
      </div>

      {groups.ignored.length > 0 ? (
        <details className="ai-draft-resolved-summary tone-neutral ai-inventory-intake-ignored" aria-label="已忽略">
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

      <AiDraftImpactNote tone="plan" title="确认后将" className="ai-inventory-intake-submit-summary">
        <p>{inventoryIntakeSubmitSummary(draft)}</p>
      </AiDraftImpactNote>
    </section>
  );
}

export { validateInventoryIntakeDraftForSubmit } from './aiInventoryIntakeDraftModel';
