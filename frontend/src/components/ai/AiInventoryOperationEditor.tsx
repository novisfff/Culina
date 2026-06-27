import { useState } from 'react';
import type { AiInventoryBatchOption, MediaAsset } from '../../api/types';
import { resolveMediaUrl } from '../../lib/assets';
import { MediaWithPlaceholder } from '../MediaPlaceholder';
import { ApprovalSelectField } from './AiApprovalFields';

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

function asText(value: unknown, fallback = '') {
  return typeof value === 'string' ? value : fallback;
}

function asNumber(value: unknown, fallback = 1) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function asDraftArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter(
        (item): item is Record<string, unknown> => (
          typeof item === 'object' && item !== null && !Array.isArray(item)
        ),
      )
    : [];
}

export function AiInventoryOperationEditor({
  draft,
  readonly,
  onUpdateItem,
  onRemoveItem,
}: {
  draft: Record<string, unknown>;
  readonly: boolean;
  onUpdateItem: (index: number, patch: Record<string, unknown>) => void;
  onRemoveItem: (index: number) => void;
}) {
  const operations = asDraftArray(draft.operations);
  const [expandedDetails, setExpandedDetails] = useState<Record<string, boolean>>({});
  const toggleDetails = (key: string) => {
    setExpandedDetails((current) => ({ ...current, [key]: !current[key] }));
  };

  return (
    <div className="ai-recipe-editor ai-confirmation-editor ai-inventory-operation-editor">
      <div className="ai-draft-editor-head">
        <div>
          <strong>库存处理项</strong>
          <span>{operations.length} 项 · 确认后统一执行</span>
        </div>
      </div>
      {operations.map((item, index) => {
        const action = asText(item.action, 'consume');
        const ingredientId = asText(item.ingredientId) || asText(item.ingredient_id);
        const inventoryItemId = asText(item.inventoryItemId) || asText(item.inventory_item_id);
        const detailKey = `${action}-${inventoryItemId || ingredientId}-${index}`;
        const batchOptions = Array.isArray(item.batchOptions)
          ? item.batchOptions.filter(
              (option): option is AiInventoryBatchOption => (
                typeof option === 'object'
                && option !== null
                && typeof (option as AiInventoryBatchOption).id === 'string'
              ),
            )
          : [];
        const image = typeof item.image === 'object' && item.image !== null
          ? item.image as MediaAsset
          : null;
        const conversionNote = asText(item.conversionNote);
        const sourceQuantity = typeof item.sourceQuantity === 'number' && Number.isFinite(item.sourceQuantity) ? item.sourceQuantity : null;
        const sourceUnit = asText(item.sourceUnit);
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
                  <strong>{asText(item.ingredientName, '食材')}</strong>
                  <span className={`ai-inventory-operation-kind action-${action}`}>
                    {ACTION_LABELS[action] ?? '处理'}
                  </span>
                </div>
                {action === 'dispose' && (
                  <small>
                    所选批次剩余 {asNumber(item.remainingQuantity, asNumber(item.quantity))}
                    {asText(item.unit)}
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
                    value={asNumber(item.quantity)}
                    disabled={readonly}
                    onChange={(event) => onUpdateItem(index, {
                      quantity: Number(event.target.value) || 0.01,
                    })}
                  />
                  <input
                    className="text-input compact-input unit-input"
                    value={asText(item.unit)}
                    disabled={readonly}
                    placeholder="单位"
                    onChange={(event) => onUpdateItem(index, { unit: event.target.value })}
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
                  <div className="ai-inventory-dispose-fields">
                    <div className="ai-inventory-batch-summary compact-batch">
                      <span>销毁批次</span>
                      <strong>
                        {batchOptions.find((option) => option.id === inventoryItemId)?.label
                          ?? '当前所选批次'}
                      </strong>
                    </div>
                    <label className="ai-resource-field ai-confirmation-copy-field ai-inventory-dispose-reason">
                      <span className="sr-only">销毁原因</span>
                      <textarea
                        className="text-input compact-reason-textarea"
                        rows={1}
                        required
                        value={asText(item.reason)}
                        disabled={readonly}
                        placeholder="请填写销毁原因，例如已过期、变质、包装破损"
                        onChange={(event) => onUpdateItem(index, { reason: event.target.value })}
                      />
                    </label>
                  </div>
                )}

                {action === 'consume' && batchOptions.length > 0 && (
                  <div className="ai-inventory-progressive-section">
                    <button
                      className="tertiary-button ai-inventory-detail-toggle"
                      type="button"
                      aria-expanded={Boolean(expandedDetails[detailKey])}
                      onClick={() => toggleDetails(detailKey)}
                    >
                      {expandedDetails[detailKey] ? '收起批次选择' : '指定库存批次'}
                    </button>
                    {expandedDetails[detailKey] && (
                      <label className="ai-resource-field">
                        <span>库存批次</span>
                        <select
                          className="text-input"
                          value={inventoryItemId}
                          disabled={readonly}
                          onChange={(event) => onUpdateItem(index, {
                            inventoryItemId: event.target.value || null,
                          })}
                        >
                          <option value="">自动按临期优先</option>
                          {batchOptions.map((option) => (
                            <option value={option.id} key={option.id}>
                              {option.label} · 剩余 {option.remainingQuantity}{option.unit}
                            </option>
                          ))}
                        </select>
                      </label>
                    )}
                  </div>
                )}

                {action === 'restock' && (
                  <div className="ai-inventory-progressive-section">
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
                              value={asText(item.purchaseDate)}
                              disabled={readonly}
                              onChange={(event) => onUpdateItem(index, { purchaseDate: event.target.value })}
                            />
                          </label>
                          <label className="ai-resource-field">
                            <span>到期日期</span>
                            <input
                              className="text-input"
                              type="date"
                              value={asText(item.expiryDate)}
                              disabled={readonly}
                              onChange={(event) => onUpdateItem(index, {
                                expiryDate: event.target.value || null,
                              })}
                            />
                          </label>
                        </div>
                        <div className="ai-confirmation-grid">
                          <label className="ai-resource-field">
                            <span>存放位置</span>
                            <input
                              className="text-input"
                              value={asText(item.storageLocation)}
                              disabled={readonly}
                              onChange={(event) => onUpdateItem(index, {
                                storageLocation: event.target.value,
                              })}
                            />
                          </label>
                          <ApprovalSelectField
                            label="库存状态"
                            value={asText(item.status, 'fresh')}
                            disabled={readonly}
                            options={INVENTORY_STATUS_OPTIONS}
                            icon="type"
                            onChange={(value) => onUpdateItem(index, { status: value })}
                          />
                        </div>
                        <label className="ai-resource-field ai-confirmation-copy-field">
                          <span>备注</span>
                          <textarea
                            className="text-input"
                            rows={2}
                            value={asText(item.notes)}
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
