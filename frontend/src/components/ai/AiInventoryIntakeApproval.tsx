import { useMemo, useState } from 'react';

import { INVENTORY_STORAGE_PRESETS } from '../ingredients/ingredientWorkspaceForms';
import { DatePickerField } from '../ui-kit';
import { ApprovalComboboxField, ApprovalSelectField } from './AiApprovalFields';
import { asText } from './aiDraftValueUtils';
import { AiDraftImpactNote } from './draft-ui/AiDraftImpactNote';
import { AiDraftResolvedSummary } from './draft-ui/AiDraftResolvedSummary';
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
  type InventoryIntakeIgnoredItem,
  type InventoryIntakePackageConversion,
  type InventoryIntakeSourceKind,
} from './aiInventoryIntakeDraftModel';

type DraftRecord = Record<string, unknown>;

type AiInventoryIntakeApprovalProps = {
  draft: DraftRecord | InventoryIntakeDraft;
  readonly?: boolean;
  status?: string;
  onChange: (draft: InventoryIntakeDraft) => void;
};

function resolvedStatus(status: string): 'approved' | 'rejected' | 'expired' | 'cancelled' | 'canceled' {
  if (status === 'approved' || status === 'rejected' || status === 'expired' || status === 'cancelled' || status === 'canceled') {
    return status;
  }
  return 'expired';
}

function resolvedTitle(status: string) {
  if (status === 'approved') return '库存已确认';
  if (status === 'rejected') return '本次库存未保存';
  if (status === 'expired') return '本次库存建议已过期';
  return '本次库存建议已处理';
}

const STORAGE_LOCATION_OPTIONS = INVENTORY_STORAGE_PRESETS.map((storage) => ({
  value: storage,
  label: storage,
}));

const PRESENCE_LEVEL_OPTIONS = [
  { value: 'sufficient', label: '充足' },
  { value: 'present_unknown', label: '有库存，数量不确定' },
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

function inventoryIntakeItemTitle(item: InventoryIntakeDraftItem) {
  if (item.title.trim()) return item.title.trim();
  return item.targetKind === 'food' ? '未命名食物' : '未命名食材';
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
  const title = inventoryIntakeItemTitle(item);
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
          {needsAttention ? '需要补充' : '已就绪'}
        </span>
        <svg
          className={`ai-inventory-intake-chevron-icon${expanded ? ' is-expanded' : ''}`}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>

      {expanded ? (
        <div className="ai-inventory-intake-row-body">
          {item.sourceText ? (
            <div className="ai-inventory-intake-source-text">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                <polyline points="14 2 14 8 20 8" />
                <line x1="16" y1="13" x2="8" y2="13" />
                <line x1="16" y1="17" x2="8" y2="17" />
              </svg>
              <span>{item.sourceText}</span>
            </div>
          ) : null}

          <ApprovalSelectField
            label="处理方式"
            value={item.action || ''}
            disabled={readonly || !item.sourceKind}
            options={actionOptions}
            className="ai-inventory-intake-field"
            onChange={(action) => onPatch({ action: action as InventoryIntakeDraftItem['action'] })}
          />

          {isQuantityTarget(item) ? (
            <div className="ai-inventory-intake-quantity-grid">
              <label className="ai-inventory-intake-field">
                <span>实际数量</span>
                <input
                  className="text-input"
                  type="number"
                  min="0"
                  step="any"
                  aria-label={`${title}实际数量`}
                  value={quantityInputValue(item.enteredQuantity)}
                  disabled={readonly}
                  onChange={(event) => onPatch({ enteredQuantity: event.target.value })}
                />
              </label>
              <label className="ai-inventory-intake-field">
                <span>单位</span>
                <input
                  className="text-input"
                  aria-label={`${title}实际数量单位`}
                  value={asText(item.enteredUnit)}
                  disabled={readonly}
                  onChange={(event) => onPatch({ enteredUnit: event.target.value })}
                />
              </label>
            </div>
          ) : null}

          {isPresenceTarget(item) ? (
            <ApprovalSelectField
              label="加入库存后的状态"
              value={asText(item.resultingAvailabilityLevel, 'sufficient')}
              disabled={readonly}
              options={PRESENCE_LEVEL_OPTIONS}
              className="ai-inventory-intake-field"
              onChange={(resultingAvailabilityLevel) => onPatch({ resultingAvailabilityLevel })}
            />
          ) : null}

          {conversion && showStockFields && item.targetKind !== 'presence_ingredient' ? (
            <fieldset className="ai-inventory-intake-conversion" aria-label={`${title}包装换算`}>
              <legend>包装换算</legend>
              <div className="ai-inventory-intake-quantity-grid">
                <label className="ai-inventory-intake-field">
                  <span>每个包装对应数量</span>
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
                  <span>库存单位</span>
                  <input
                    className="text-input"
                    value={asText(conversion.targetUnit)}
                    disabled={readonly}
                    onChange={(event) => updateConversion({ targetUnit: event.target.value })}
                  />
                </label>
              </div>
              <label className="ai-inventory-intake-field">
                <span>换算依据</span>
                <input
                  className="text-input"
                  value={asText(conversion.evidence)}
                  disabled={readonly}
                  onChange={(event) => updateConversion({ evidence: event.target.value })}
                />
              </label>
            </fieldset>
          ) : null}

          {showStockFields ? (
            <div className="ai-inventory-intake-advanced-grid">
              <ApprovalComboboxField
                label="存放位置"
                value={asText(item.storageLocation)}
                disabled={readonly}
                placeholder="选择或输入存放位置"
                options={STORAGE_LOCATION_OPTIONS}
                allowCustom
                className="ai-inventory-intake-field"
                onChange={(storageLocation) => onPatch({ storageLocation })}
              />
              <label className="ai-inventory-intake-field">
                <span>到期日</span>
                <DatePickerField
                  ariaLabel="到期日"
                  value={asText(item.expiryDate)}
                  disabled={readonly}
                  allowClear
                  onChange={(expiryDate) => onPatch({ expiryDate: expiryDate || null })}
                />
              </label>
              {item.targetKind !== 'food' && item.targetKind !== 'presence_ingredient' ? (
                <ApprovalSelectField
                  label="库存状态"
                  value={asText(item.inventoryStatus, 'fresh')}
                  disabled={readonly}
                  options={INVENTORY_STATUS_OPTIONS}
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
  status = 'pending',
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
  const [isIgnoredExpanded, setIsIgnoredExpanded] = useState(false);

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
    { label: '记录日期', value: draft.intakeDate || '未填写' },
    { label: '日期依据', value: intakeDateSourceLabel(String(draft.intakeDateSource)) },
    { label: '待确认', value: `${activeCount} 项` },
    { label: '采购清单内容', value: `${groups.shopping.length} 项` },
    { label: '直接加入库存', value: `${groups.direct.length} 项` },
    { label: '已忽略', value: `${groups.ignored.length} 项` },
  ];

  if (status !== 'pending') {
    const resolvedGroup = (
      title: string,
      description: string,
      items: Array<InventoryIntakeDraftItem | InventoryIntakeIgnoredItem>,
    ) => (
      <AiDraftSection
        title={title}
        description={description}
        action={<span className="ai-inventory-intake-group-count">{items.length} 项</span>}
        className="ai-inventory-intake-resolved-group"
      >
        <ul className="ai-inventory-intake-resolved-list">
          {items.map((item, index) => (
            <li key={asText(item.lineId) || asText(item.sourceLineId) || `${title}-${index}`}>
              <strong>{asText(item.displayName) || asText(item.title) || asText(item.sourceText) || '未命名内容'}</strong>
              <span>{asText(item.reason) || (asText(item.lineId) ? inventoryIntakeItemSummary(item as InventoryIntakeDraftItem) : '本次不会加入库存')}</span>
            </li>
          ))}
        </ul>
      </AiDraftSection>
    );

    return (
      <section className="ai-inventory-intake-editor" aria-label="确认库存更新内容">
        <AiDraftResolvedSummary
          status={resolvedStatus(status)}
          title={resolvedTitle(status)}
          summary="保留本次库存更新范围与结果，方便后续核对。"
          className="ai-inventory-intake-summary-card"
        >
          <dl className="ai-draft-summary-items">
            {overviewItems.map((item) => (
              <div key={item.label} className="ai-draft-summary-item">
                <dt>{item.label}</dt>
                <dd>{item.value}</dd>
              </div>
            ))}
          </dl>
          {groups.shopping.length > 0 ? resolvedGroup('采购清单内容', '对应待买内容的库存结果。', groups.shopping) : null}
          {groups.direct.length > 0 ? resolvedGroup('直接加入库存', '本次直接保存到库存的内容。', groups.direct) : null}
          {groups.ignored.length > 0 ? resolvedGroup('已忽略', '不会保存到库存的内容。', groups.ignored) : null}
        </AiDraftResolvedSummary>
      </section>
    );
  }

  return (
      <section className="ai-inventory-intake-editor" aria-label="确认库存更新内容">
      <AiDraftSummaryCard
        title="本次库存更新概览"
        items={overviewItems}
        className="ai-inventory-intake-overview ai-inventory-intake-summary-card"
      />

      {!readonly ? (
        <div className="ai-inventory-intake-date-config" aria-label="记录日期设置">
          <label className="ai-inventory-intake-date-field">
            <span className="ai-inventory-intake-date-label">
              <svg
                className="ai-inventory-intake-date-icon"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <rect x="4.5" y="5.5" width="15" height="14" rx="3" />
                <path d="M8 3.8v3.4M16 3.8v3.4M4.8 10h14.4" />
              </svg>
              调整记录日期
            </span>
            <div className="ai-inventory-intake-date-input-wrap">
              <DatePickerField
                ariaLabel="记录日期"
                value={draft.intakeDate}
                required
                disabled={readonly}
                onChange={handleDateChange}
              />
              <span className="ai-inventory-intake-source-badge">{intakeDateSourceLabel(String(draft.intakeDateSource))}</span>
            </div>
          </label>
        </div>
      ) : null}

      {attentionItems.length > 0 ? (
        <AiDraftImpactNote tone="warning" title="还需要补充" className="ai-inventory-intake-attention">
          <p>{attentionItems.map((item) => inventoryIntakeItemTitle(item)).join('、')} 仍缺少库存信息。</p>
          <p>补齐标记的内容后即可统一加入库存。</p>
        </AiDraftImpactNote>
      ) : null}

      <div className="ai-inventory-intake-groups" aria-label="库存清单">
        {groups.shopping.length > 0 ? (
          <AiDraftSection
            title="采购清单内容"
            description="加入库存后会同时完成对应待买内容。"
            action={<span className="ai-inventory-intake-group-count">{groups.shopping.length} 项</span>}
            className="ai-inventory-intake-group"
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
            title="直接加入库存"
            description="这里只会加入库存，不会新增或完成采购清单内容。"
            action={<span className="ai-inventory-intake-group-count">{groups.direct.length} 项</span>}
            className="ai-inventory-intake-group"
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
        <section className={`ai-draft-section ai-inventory-intake-ignored${isIgnoredExpanded ? ' is-expanded' : ''}`}>
          <button
            type="button"
            className="ai-inventory-intake-ignored-toggle"
            aria-expanded={isIgnoredExpanded}
            onClick={() => setIsIgnoredExpanded((current) => !current)}
          >
            <div className="ai-draft-section-copy">
              <h3>已忽略</h3>
              <p>不会保存到库存，也无需确认</p>
            </div>
            <div className="ai-inventory-intake-ignored-header-action">
              <span className="ai-inventory-intake-group-count">{groups.ignored.length} 项</span>
              <svg
                className={`ai-inventory-intake-chevron-icon${isIgnoredExpanded ? ' is-expanded' : ''}`}
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <polyline points="6 9 12 15 18 9" />
              </svg>
            </div>
          </button>
          <div
            className="ai-draft-section-body"
            style={{ display: isIgnoredExpanded ? 'block' : 'none' }}
          >
            <div className="ai-inventory-intake-ignored-list">
              {groups.ignored.map((item, index) => (
                <div className="ai-inventory-intake-ignored-card" key={item.sourceLineId || `ignored-${index}`}>
                  <div className="ai-inventory-intake-ignored-copy">
                    <strong>{item.displayName || item.sourceText || '已忽略内容'}</strong>
                    <p>{item.reason || '这项内容不是食品，本次不会加入库存。'}</p>
                  </div>
                  <span className="ai-inventory-intake-ignored-badge">已忽略</span>
                </div>
              ))}
            </div>
          </div>
        </section>
      ) : null}

      <AiDraftImpactNote tone="plan" title="确认后将" className="ai-inventory-intake-submit-summary">
        <p>{inventoryIntakeSubmitSummary(draft)}</p>
      </AiDraftImpactNote>
    </section>
  );
}

export { validateInventoryIntakeDraftForSubmit } from './aiInventoryIntakeDraftModel';
