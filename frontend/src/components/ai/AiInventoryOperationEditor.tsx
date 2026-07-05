import { useState } from 'react';
import type { AiInventoryBatchOption, InventoryStatus } from '../../api/types';
import { resolveMediaUrl } from '../../lib/assets';
import { INVENTORY_STORAGE_PRESETS, buildUnitPresetOptions } from '../ingredients/ingredientWorkspaceForms';
import { MediaWithPlaceholder } from '../MediaPlaceholder';
import { ApprovalComboboxField, ApprovalSelectField } from './AiApprovalFields';
import type { InventoryOperationDraftItemPatch, InventoryOperationDraftItemViewModel, InventoryOperationDraftViewModel } from './aiInventoryOperationDraftModel';
import { draftNumberFromInput, draftNumberInputValue } from './aiDraftValueUtils';

const ACTION_LABELS: Record<string, string> = {
  restock: '补货',
  consume: '消耗',
  dispose: '销毁',
};

const INVENTORY_STATUS_OPTIONS = [
  { value: 'fresh', label: '新鲜' },
  { value: 'opened', label: '已开封' },
  { value: 'frozen', label: '冷冻' },
  { value: 'expiring', label: '临期' },
];

function formatInventoryQuantity(quantity: unknown, unit: string | null | undefined) {
  const numeric = typeof quantity === 'number' && Number.isFinite(quantity) ? quantity : 0;
  const display = Number.isInteger(numeric) ? String(numeric) : String(Number(numeric.toFixed(2)));
  const unitText = unit ?? '';
  return `${display}${unitText ? ` ${unitText}` : ''}`;
}

function inventorySummaryItems(operations: InventoryOperationDraftItemViewModel[]) {
  const counts = operations.reduce<Record<string, number>>((acc, item) => {
    const action = item.action || 'consume';
    acc[action] = (acc[action] ?? 0) + 1;
    return acc;
  }, {});
  const ingredientIds = new Set(operations.map((item) => item.ingredientId || item.ingredientName).filter(Boolean));
  return [
    { label: '补货', value: `${counts.restock ?? 0} 项` },
    { label: '消耗', value: `${counts.consume ?? 0} 项` },
    { label: '销毁', value: `${counts.dispose ?? 0} 项` },
    { label: '涉及食材', value: `${ingredientIds.size} 种` },
  ];
}

function unitOptionsForItem(item: InventoryOperationDraftItemViewModel) {
  const preferred = item.defaultUnit || item.unit;
  return buildUnitPresetOptions(preferred).map((unit) => ({ value: unit, label: unit }));
}

function storageOptionsForItem(item: InventoryOperationDraftItemViewModel) {
  const values = [
    ...item.storageLocationOptions,
    ...item.ingredientStorageLocations,
    item.defaultStorage ?? '',
    item.storageLocation ?? '',
    ...INVENTORY_STORAGE_PRESETS,
  ].map((value) => value.trim()).filter(Boolean);
  return Array.from(new Set(values)).map((value) => ({ value, label: value }));
}

function batchLabel(batchOptions: AiInventoryBatchOption[], inventoryItemId: string) {
  if (!inventoryItemId) return '自动选择批次';
  return batchOptions.find((option) => option.id === inventoryItemId)?.label ?? '当前所选批次';
}

function operationDescription(action: string, item: InventoryOperationDraftItemViewModel, batchOptions: AiInventoryBatchOption[], inventoryItemId: string) {
  if (action === 'restock') {
    return [
      item.storageLocation || '未设置存放位置',
      item.expiryDate ? `到期 ${item.expiryDate}` : '未设置到期日',
    ].join(' · ');
  }
  if (action === 'dispose') {
    return [
      batchLabel(batchOptions, inventoryItemId),
      `剩余 ${formatInventoryQuantity(item.remainingQuantity, item.unit)}`,
      item.reason || '待填写原因',
    ].join(' · ');
  }
  return inventoryItemId
    ? `指定批次：${batchLabel(batchOptions, inventoryItemId)}`
    : '自动临期优先扣减';
}

export function AiInventoryOperationEditor({
  draft,
  readonly,
  onUpdateItem,
  onRemoveItem,
}: {
  draft: InventoryOperationDraftViewModel;
  readonly: boolean;
  onUpdateItem: (index: number, patch: InventoryOperationDraftItemPatch) => void;
  onRemoveItem: (index: number) => void;
}) {
  const operations = draft.operations;
  const [expandedDetails, setExpandedDetails] = useState<Record<string, boolean>>({});
  const toggleDetails = (key: string) => {
    setExpandedDetails((current) => ({ ...current, [key]: !current[key] }));
  };
  const summaryItems = inventorySummaryItems(operations);

  if (readonly) {
    return (
      <div className="ai-recipe-editor ai-confirmation-editor ai-inventory-operation-editor">
        <section className="ai-inventory-operation-summary-card" aria-label="库存处理摘要">
          <div className="ai-recipe-summary-head">
            <div>
              <strong>库存处理结果</strong>
              <span>已按下列草稿状态处理；这里只保留结果核对摘要。</span>
            </div>
            <em>库存</em>
          </div>
          <dl className="ai-recipe-summary-grid ai-inventory-operation-summary-grid">
            {summaryItems.map((item) => (
              <div key={item.label}>
                <dt>{item.label}</dt>
                <dd>{item.value}</dd>
              </div>
            ))}
          </dl>
        </section>
        <div className="ai-inventory-section-heading">
          <strong>处理结果</strong>
          <span>每项动作的数量、批次和备注摘要</span>
        </div>
        <div className="ai-inventory-resolved-list">
          {operations.map((item, index) => {
            const action = item.action || 'consume';
            const ingredientId = item.ingredientId;
            const inventoryItemId = item.inventoryItemId ?? '';
            const batchOptions = item.batchOptions;
            return (
              <article className={`ai-inventory-resolved-card action-${action}`} key={`${action}-${inventoryItemId || ingredientId}-${index}`}>
                <div>
                  <strong>{item.ingredientName || '食材'}</strong>
                  <span>{operationDescription(action, item, batchOptions, inventoryItemId)}</span>
                </div>
                <em>{ACTION_LABELS[action] ?? '处理'} · {formatInventoryQuantity(item.quantity, item.unit)}</em>
              </article>
            );
          })}
        </div>
      </div>
    );
  }

  return (
    <div className="ai-recipe-editor ai-confirmation-editor ai-inventory-operation-editor">
      <section className="ai-inventory-operation-summary-card" aria-label="库存处理摘要">
        <div className="ai-recipe-summary-head">
          <div>
            <strong>待确认库存处理</strong>
            <span>{operations.length} 项 · 确认后会正式修改家庭库存</span>
          </div>
          <em>库存</em>
        </div>
        <dl className="ai-recipe-summary-grid ai-inventory-operation-summary-grid">
          {summaryItems.map((item) => (
            <div key={item.label}>
              <dt>{item.label}</dt>
              <dd>{item.value}</dd>
            </div>
          ))}
        </dl>
      </section>
      <div className="ai-inventory-section-heading">
        <strong>主要处理项</strong>
        <span>核对食材、动作、数量和单位</span>
      </div>
      {operations.map((item, index) => {
        const action = item.action || 'consume';
        const ingredientId = item.ingredientId;
        const inventoryItemId = item.inventoryItemId ?? '';
        const detailKey = `${action}-${inventoryItemId || ingredientId}-${index}`;
        const batchOptions = item.batchOptions;
        const image = item.image;
        const conversionNote = item.conversionNote ?? '';
        const sourceQuantity = item.sourceQuantity;
        const sourceUnit = item.sourceUnit ?? '';
        const conversionSummary = conversionNote || (
          sourceQuantity !== null && sourceUnit
            ? `来自 ${sourceQuantity} ${sourceUnit}`
            : ''
        );

        return (
          <div
            className={`ai-confirmation-item ai-inventory-operation-item action-${action}`}
            key={detailKey}
          >
            <div className="ai-inventory-operation-main-row">
              {image ? (
                <MediaWithPlaceholder
                  className="ai-inventory-operation-img"
                  src={resolveMediaUrl(image, 'thumb')}
                  alt=""
                  showLabel={false}
                  ariaHidden
                />
              ) : (
                <span className="ai-inventory-operation-placeholder" aria-hidden="true">食</span>
              )}
              <div className="ai-inventory-operation-info">
                <div className="ai-inventory-operation-title-row">
                  <strong>{item.ingredientName || '食材'}</strong>
                  <span className={`ai-inventory-operation-kind action-${action}`}>
                    {ACTION_LABELS[action] ?? '处理'}
                  </span>
                </div>
                {action === 'dispose' && (
                  <small>
                    所选批次剩余 {item.remainingQuantity ?? item.quantity}
                    {item.unit}
                  </small>
                )}
                {action === 'consume' && !inventoryItemId && <small>默认按临期优先扣减</small>}
              </div>

              <div className="ai-inventory-operation-inputs">
                <div className="ai-resource-inputs-flex">
                  <span className="sr-only">
                    {action === 'restock' ? '入库数量' : action === 'dispose' ? '销毁数量' : '消耗数量'}
                  </span>
                  <input
                    className="text-input compact-input quantity-input"
                    type="number"
                    min={0.01}
                    step={0.01}
                    value={draftNumberInputValue(item.quantity, 0.01)}
                    disabled={readonly}
                    onChange={(event) => onUpdateItem(index, {
                      quantity: draftNumberFromInput(event.target.value),
                    })}
                  />
                  <ApprovalComboboxField
                    label="单位"
                    value={item.unit}
                    disabled={readonly}
                    placeholder="单位"
                    options={unitOptionsForItem(item)}
                    icon="type"
                    className="ai-inventory-unit-field"
                    onChange={(value) => onUpdateItem(index, { unit: value })}
                  />
                </div>
                {conversionSummary && (
                  <small className="ai-inventory-conversion-note">
                    {conversionSummary}
                  </small>
                )}
              </div>

              {!readonly && operations.length > 1 && (
                <button
                  className="ghost-button ai-draft-remove-button compact-remove"
                  type="button"
                  onClick={() => onRemoveItem(index)}
                >
                  删除
                </button>
              )}
            </div>

            {(action === 'dispose' || (action === 'consume' && batchOptions.length > 0) || action === 'restock') && (
              <div className="ai-inventory-operation-details">
                {action === 'dispose' && (
                  <div className="ai-inventory-danger-card">
                    <div className="ai-inventory-section-heading compact">
                      <strong>原因和备注</strong>
                      <span>销毁库存必须填写原因，确认后会减少该批次数量</span>
                    </div>
                    <div className="ai-inventory-dispose-fields">
                      <div className="ai-inventory-batch-summary compact-batch">
                        <span>销毁批次</span>
                        <strong>{batchLabel(batchOptions, inventoryItemId)}</strong>
                      </div>
                      <div className="ai-inventory-batch-summary compact-batch">
                        <span>剩余数量</span>
                        <strong>{formatInventoryQuantity(item.remainingQuantity, item.unit)}</strong>
                      </div>
                      <label className="ai-resource-field ai-confirmation-copy-field ai-inventory-dispose-reason">
                        <span>销毁原因</span>
                        <textarea
                          className="text-input compact-reason-textarea"
                          rows={2}
                          required
                          value={item.reason}
                          disabled={readonly}
                          placeholder="请填写销毁原因，例如已过期、变质、包装破损"
                          onChange={(event) => onUpdateItem(index, { reason: event.target.value })}
                        />
                      </label>
                    </div>
                  </div>
                )}

                {action === 'consume' && batchOptions.length > 0 && (
                  <div className="ai-inventory-progressive-section">
                    <div className="ai-inventory-section-heading compact">
                      <strong>批次与位置</strong>
                      <span>
                        {inventoryItemId
                          ? '当前指定了库存批次；只会扣减所选批次。'
                          : '自动临期优先：确认时会优先扣减更早到期的库存。'}
                      </span>
                    </div>
                    <button
                      className="tertiary-button ai-inventory-detail-toggle"
                      type="button"
                      aria-expanded={Boolean(expandedDetails[detailKey])}
                      onClick={() => toggleDetails(detailKey)}
                    >
                      {expandedDetails[detailKey] ? '收起批次选择' : '指定库存批次'}
                    </button>
                    {expandedDetails[detailKey] && (
                      <ApprovalSelectField
                        label="库存批次"
                        value={inventoryItemId}
                        disabled={readonly}
                        options={[
                          { value: '', label: '自动按临期优先' },
                          ...batchOptions.map((option) => ({
                            value: option.id,
                            label: `${option.label} · 剩余 ${option.remainingQuantity}${option.unit}`,
                          })),
                        ]}
                        icon="type"
                        onChange={(value) => onUpdateItem(index, { inventoryItemId: value || null })}
                      />
                    )}
                  </div>
                )}

                {action === 'restock' && (
                  <div className="ai-inventory-progressive-section">
                    <div className="ai-inventory-section-heading compact">
                      <strong>批次与位置</strong>
                      <span>可补充采购日期、到期日期、存放位置和库存状态</span>
                    </div>
                    <button
                      className="tertiary-button ai-inventory-detail-toggle"
                      type="button"
                      aria-expanded={Boolean(expandedDetails[detailKey])}
                      onClick={() => toggleDetails(detailKey)}
                    >
                      {expandedDetails[detailKey] ? '收起入库信息' : '更多入库信息'}
                    </button>
                    {expandedDetails[detailKey] && (
                      <div className="ai-inventory-extra-fields">
                        <div className="ai-confirmation-grid">
                          <label className="ai-resource-field">
                            <span>采购日期</span>
                            <input
                              className="text-input"
                              type="date"
                              value={item.purchaseDate ?? ''}
                              disabled={readonly}
                              onChange={(event) => onUpdateItem(index, { purchaseDate: event.target.value })}
                            />
                          </label>
                          <label className="ai-resource-field">
                            <span>到期日期</span>
                            <input
                              className="text-input"
                              type="date"
                              value={item.expiryDate ?? ''}
                              disabled={readonly}
                              onChange={(event) => onUpdateItem(index, {
                                expiryDate: event.target.value || null,
                              })}
                            />
                          </label>
                        </div>
                        <div className="ai-confirmation-grid">
                          <ApprovalComboboxField
                            label="存放位置"
                            value={item.storageLocation ?? ''}
                            disabled={readonly}
                            placeholder="选择或输入位置"
                            options={storageOptionsForItem(item)}
                            icon="type"
                            onChange={(value) => onUpdateItem(index, { storageLocation: value })}
                          />
                          <ApprovalSelectField
                            label="库存状态"
                            value={item.status || 'fresh'}
                            disabled={readonly}
                            options={INVENTORY_STATUS_OPTIONS}
                            icon="type"
                            onChange={(value) => onUpdateItem(index, { status: value as InventoryStatus })}
                          />
                        </div>
                        <div className="ai-inventory-section-heading compact">
                          <strong>原因和备注</strong>
                          <span>补充本次补货的来源、包装或特殊保存提醒</span>
                        </div>
                        <label className="ai-resource-field ai-confirmation-copy-field">
                          <span>备注</span>
                          <textarea
                            className="text-input"
                            rows={2}
                            value={item.notes}
                            disabled={readonly}
                            onChange={(event) => onUpdateItem(index, { notes: event.target.value })}
                          />
                        </label>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
