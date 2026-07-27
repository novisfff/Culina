import { useState } from 'react';
import type { AiInventoryBatchOption, InventoryStatus } from '../../api/types';
import { resolveMediaUrl } from '../../lib/assets';
import { INVENTORY_STORAGE_PRESETS, buildUnitPresetOptions } from '../ingredients/ingredientWorkspaceForms';
import { MediaWithPlaceholder } from '../MediaPlaceholder';
import { ApprovalComboboxField, ApprovalSelectField } from './AiApprovalFields';
import type {
  InventoryOperationDraftItemPatch,
  InventoryOperationDraftItemViewModel,
  InventoryOperationDraftViewModel,
} from './aiInventoryOperationDraftModel';
import { draftNumberFromInput, draftNumberInputValue } from './aiDraftValueUtils';
import { AiDraftImpactNote } from './draft-ui/AiDraftImpactNote';
import { AiDraftItemCard } from './draft-ui/AiDraftItemCard';
import { AiDraftResolvedSummary } from './draft-ui/AiDraftResolvedSummary';
import { AiDraftSection } from './draft-ui/AiDraftSection';
import { AiDraftSummaryCard } from './draft-ui/AiDraftSummaryCard';

const ACTION_LABELS: Record<string, string> = {
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

function operationDescription(
  action: string,
  item: InventoryOperationDraftItemViewModel,
  batchOptions: AiInventoryBatchOption[],
  inventoryItemId: string,
) {
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

function resolvedStatus(status: string): 'approved' | 'rejected' | 'expired' | 'cancelled' | 'canceled' {
  if (status === 'approved' || status === 'rejected' || status === 'expired' || status === 'cancelled' || status === 'canceled') {
    return status;
  }
  return 'expired';
}

export function AiInventoryOperationEditor({
  draft,
  readonly,
  status,
  onUpdateItem,
  onRemoveItem,
}: {
  draft: InventoryOperationDraftViewModel;
  readonly: boolean;
  status?: string;
  onUpdateItem: (index: number, patch: InventoryOperationDraftItemPatch) => void;
  onRemoveItem: (index: number) => void;
}) {
  const operations = draft.operations;
  const [expandedDetails, setExpandedDetails] = useState<Record<string, boolean>>({});
  const toggleDetails = (key: string) => {
    setExpandedDetails((current) => ({ ...current, [key]: !current[key] }));
  };
  const summaryItems = inventorySummaryItems(operations);
  const isResolved = Boolean(status && status !== 'pending');

  if (readonly) {
    const resultCards = (
      <div className="ai-inventory-operation-result-list">
        <div className="ai-inventory-operation-result-copy">
          <h4>处理结果</h4>
          <p>每项动作的数量、批次和备注摘要</p>
        </div>
        {operations.map((item, index) => {
          const action = item.action || 'consume';
          const ingredientId = item.ingredientId;
          const inventoryItemId = item.inventoryItemId ?? '';
          const batchOptions = item.batchOptions;
          return (
            <AiDraftItemCard
              key={`${action}-${inventoryItemId || ingredientId}-${index}`}
              title={item.ingredientName || '食材'}
              summary={operationDescription(action, item, batchOptions, inventoryItemId)}
              status={`${ACTION_LABELS[action] ?? '处理'} · ${formatInventoryQuantity(item.quantity, item.unit)}`}
              className={`ai-inventory-operation-resolved-item action-${action}`}
            >
              {action === 'dispose' && item.reason ? <p>销毁原因：{item.reason}</p> : null}
            </AiDraftItemCard>
          );
        })}
      </div>
    );

    return (
      <div className="ai-recipe-editor ai-confirmation-editor ai-inventory-operation-editor">
        {isResolved ? (
          <AiDraftResolvedSummary
            status={resolvedStatus(status ?? '')}
            title="库存处理结果"
            summary="已按下列草稿状态处理；这里只保留结果核对摘要。"
            className="ai-inventory-operation-resolved-summary"
          >
            <dl className="ai-draft-summary-items">
              {summaryItems.map((item) => (
                <div key={item.label} className="ai-draft-summary-item">
                  <dt>{item.label}</dt>
                  <dd>{item.value}</dd>
                </div>
              ))}
            </dl>
            {resultCards}
          </AiDraftResolvedSummary>
        ) : (
          <AiDraftSummaryCard
            title="库存处理草稿"
            items={summaryItems}
            tone="neutral"
            className="ai-inventory-operation-summary-card"
          >
            {resultCards}
          </AiDraftSummaryCard>
        )}
      </div>
    );
  }

  return (
    <div className="ai-recipe-editor ai-confirmation-editor ai-inventory-operation-editor">
      <AiDraftSummaryCard
        title="待确认库存处理"
        items={summaryItems}
        className="ai-inventory-operation-summary-card"
      >
        <AiDraftImpactNote tone="plan" title="确认后将" className="ai-inventory-operation-submit-summary">
          <p>{operations.length} 项库存处理会正式修改家庭库存。</p>
        </AiDraftImpactNote>
      </AiDraftSummaryCard>

      <AiDraftSection
        title="主要处理项"
        description="核对食材、动作和库存信息。"
        className="ai-confirmation-item ai-inventory-operation-items-section"
      >
        <div className="ai-inventory-operation-list">
          {operations.map((item, index) => {
            const action = item.action || 'consume';
            const ingredientId = item.ingredientId;
            const inventoryItemId = item.inventoryItemId ?? '';
            const detailKey = `${action}-${inventoryItemId || ingredientId}-${index}`;
            const batchOptions = item.batchOptions;
            const canUseAutomaticBatch = item.expectedInventoryItemRowVersion == null;
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
              <AiDraftItemCard
                key={detailKey}
                title={item.ingredientName || '食材'}
                summary={operationDescription(action, item, batchOptions, inventoryItemId)}
                status={<span className={`ai-inventory-operation-kind action-${action}`}>{ACTION_LABELS[action] ?? '处理'}</span>}
                className={`ai-inventory-operation-item action-${action}`}
                footer={operations.length > 1 ? (
                  <button
                    className="ghost-button ai-draft-remove-button compact-remove"
                    type="button"
                    onClick={() => onRemoveItem(index)}
                  >
                    删除
                  </button>
                ) : undefined}
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
                    {action === 'dispose' ? (
                      <small>所选批次剩余 {item.remainingQuantity ?? item.quantity}{item.unit}</small>
                    ) : null}
                    {action === 'consume' && !inventoryItemId ? <small>默认按临期优先扣减</small> : null}
                  </div>

                  <div className="ai-inventory-operation-inputs">
                    <div className="ai-resource-inputs-flex">
                      <label className="ai-inventory-quantity-field">
                        <span>{action === 'dispose' ? '销毁数量' : '消耗数量'}</span>
                        <input
                          className="text-input compact-input quantity-input"
                          type="number"
                          min={0.01}
                          step={0.01}
                          value={draftNumberInputValue(item.quantity, 0.01)}
                          onChange={(event) => onUpdateItem(index, {
                            quantity: draftNumberFromInput(event.target.value),
                          })}
                        />
                      </label>
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
                    {conversionSummary ? <small className="ai-inventory-conversion-note">{conversionSummary}</small> : null}
                  </div>
                </div>

                {(action === 'dispose' || (action === 'consume' && batchOptions.length > 0)) ? (
                  <div className="ai-inventory-operation-details">
                    {action === 'dispose' ? (
                      <AiDraftImpactNote
                        tone="danger"
                        title="销毁影响"
                        className="ai-inventory-operation-dispose-impact"
                      >
                        <p>销毁库存必须填写原因，确认后会减少该批次数量。</p>
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
                              placeholder="请填写销毁原因，例如已过期、变质、包装破损"
                              onChange={(event) => onUpdateItem(index, { reason: event.target.value })}
                            />
                          </label>
                        </div>
                      </AiDraftImpactNote>
                    ) : null}

                    {action === 'consume' && batchOptions.length > 0 ? (
                      <div className="ai-inventory-progressive-section">
                        <div className="ai-inventory-operation-detail-copy">
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
                        {expandedDetails[detailKey] ? (
                          <ApprovalSelectField
                            label="库存批次"
                            value={inventoryItemId}
                            disabled={readonly}
                            options={[
                              ...(canUseAutomaticBatch ? [{ value: '', label: '自动按临期优先' }] : []),
                              ...batchOptions.map((option) => ({
                                value: option.id,
                                label: `${option.label} · 剩余 ${option.remainingQuantity}${option.unit}`,
                              })),
                            ]}
                            icon="type"
                            onChange={(value) => onUpdateItem(index, { inventoryItemId: value || null })}
                          />
                        ) : null}
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </AiDraftItemCard>
            );
          })}
        </div>
      </AiDraftSection>
    </div>
  );
}
