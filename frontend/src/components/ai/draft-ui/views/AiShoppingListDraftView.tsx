import type { AiApprovalRequest } from '../../../../api/types';
import { buildUnitPresetOptions } from '../../../ingredients/ingredientWorkspaceForms';
import {
  AiSearchableResourceSelect,
  ApprovalComboboxField,
  ApprovalSelectField,
} from '../../AiApprovalFields';
import type { AiResourceOption, AiResourceOptionLoader } from '../../AiApprovalFields';
import {
  asDraftArray,
  asText,
  draftNumberFromInput,
  draftNumberInputValue,
} from '../../aiDraftValueUtils';
import { AiDraftImpactNote } from '../AiDraftImpactNote';
import { AiDraftItemCard } from '../AiDraftItemCard';
import { AiDraftResolvedSummary } from '../AiDraftResolvedSummary';
import { AiDraftSection } from '../AiDraftSection';
import { AiDraftSummaryCard } from '../AiDraftSummaryCard';

const QUANTITY_MODE_OPTIONS = [
  { value: 'track_quantity', label: '记录数量' },
  { value: 'not_track_quantity', label: '只提醒需要补充' },
];

const DONE_OPTIONS = [
  { value: 'false', label: '待买' },
  { value: 'true', label: '已买到' },
];

function recordFrom(value: unknown) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function actionLabel(action: string) {
  switch (action) {
    case 'create':
      return '新增';
    case 'update':
      return '修改';
    case 'set_done':
      return '状态变更';
    case 'delete':
      return '删除';
    default:
      return action || '采购项';
  }
}

function doneLabel(value: unknown) {
  return Boolean(value) ? '已买到' : '待买';
}

function quantityMode(value: Record<string, unknown>) {
  const mode = asText(value.quantityMode) || asText(value.quantity_mode);
  return mode === 'not_track_quantity' ? 'not_track_quantity' : 'track_quantity';
}

function itemRecord(value: Record<string, unknown>) {
  const mode = quantityMode(value);
  return {
    ...value,
    title: asText(value.title) || asText(value.ingredientName) || asText(value.ingredient_name) || asText(value.name),
    ingredientId: asText(value.ingredientId) || asText(value.ingredient_id),
    quantityMode: mode,
    quantity: draftNumberInputValue(value.quantity, 1),
    unit: asText(value.unit, '份'),
    displayLabel: asText(value.displayLabel) || asText(value.display_label) || '需要补充',
    reason: asText(value.reason),
    done: Boolean(value.done),
  };
}

function formatQuantity(value: number | '') {
  const numeric = typeof value === 'number' && Number.isFinite(value) ? value : 0;
  return Number.isInteger(numeric) ? String(numeric) : String(Number(numeric.toFixed(1)));
}

function quantitySummary(value: Record<string, unknown>) {
  const item = itemRecord(value);
  if (item.quantityMode === 'not_track_quantity') return item.displayLabel || '需要补充';
  return `${formatQuantity(item.quantity)} ${item.unit}`.trim();
}

function summaryItems(items: Record<string, unknown>[], operations: Record<string, unknown>[]) {
  const records = operations.length > 0
    ? operations.map((operation) => itemRecord({
        ...recordFrom(operation.before),
        ...recordFrom(operation.payload),
      }))
    : items.map(itemRecord);
  const actionCounts = operations.reduce<Record<string, number>>((counts, operation) => {
    const label = actionLabel(asText(operation.action));
    counts[label] = (counts[label] ?? 0) + 1;
    return counts;
  }, {});
  const changeSummary = operations.length > 0
    ? Object.entries(actionCounts).map(([label, count]) => `${label}${count}`).join('、')
    : '新增采购项';

  return [
    { label: '采购项', value: `${operations.length > 0 ? operations.length : items.length} 项` },
    { label: '已绑定食材', value: `${records.filter((item) => item.ingredientId).length} 项` },
    { label: '只提醒补充', value: `${records.filter((item) => item.quantityMode === 'not_track_quantity').length} 项` },
    { label: '状态变更', value: `${operations.filter((item) => asText(item.action) === 'set_done').length} 项` },
    { label: '变更', value: changeSummary },
  ];
}

function resolvedTitle(status: AiApprovalRequest['status'], hasOperations: boolean) {
  if (status === 'approved') return hasOperations ? '购物清单变更已确认' : '购物清单已确认';
  if (status === 'rejected') return '未写入的购物清单草稿';
  if (status === 'expired') return '已过期的购物清单草稿';
  return hasOperations ? '待确认清单变更' : '待确认购物清单';
}

function resolvedStatus(status: string): 'approved' | 'rejected' | 'expired' | 'cancelled' | 'canceled' {
  if (status === 'approved' || status === 'rejected' || status === 'expired' || status === 'cancelled' || status === 'canceled') {
    return status;
  }
  return 'expired';
}

export function AiShoppingListDraftView(props: {
  draft: Record<string, unknown>;
  readonly: boolean;
  status: AiApprovalRequest['status'];
  ingredientOptions: readonly AiResourceOption[];
  onDraftChange: (next: Record<string, unknown>) => void;
  onLoadResourceOptions: AiResourceOptionLoader;
}) {
  const operations = asDraftArray(props.draft.operations);
  const items = asDraftArray(props.draft.items);
  const hasOperations = operations.length > 0;
  const draftSummaryItems = summaryItems(items, operations);

  const updateDraftItem = (key: string, index: number, patch: Record<string, unknown>) => {
    const currentItems = asDraftArray(props.draft[key]);
    props.onDraftChange({
      ...props.draft,
      [key]: currentItems.map((item, itemIndex) => (
        itemIndex === index ? { ...item, ...patch } : item
      )),
    });
  };

  const addDraftItem = (key: string, item: Record<string, unknown>) => {
    props.onDraftChange({ ...props.draft, [key]: [...asDraftArray(props.draft[key]), item] });
  };

  const removeDraftItem = (key: string, index: number) => {
    const currentItems = asDraftArray(props.draft[key]);
    if (currentItems.length <= 1) return;
    props.onDraftChange({
      ...props.draft,
      [key]: currentItems.filter((_, itemIndex) => itemIndex !== index),
    });
  };

  const updateOperationPayloadItem = (index: number, patch: Record<string, unknown>) => {
    props.onDraftChange({
      ...props.draft,
      operations: operations.map((operation, operationIndex) => (
        operationIndex === index
          ? { ...operation, payload: { ...recordFrom(operation.payload), ...patch } }
          : operation
      )),
    });
  };

  const findIngredientOption = (record: Record<string, unknown>) => {
    const item = itemRecord(record);
    return props.ingredientOptions.find((option) => option.id === item.ingredientId || option.label === item.title) ?? null;
  };

  const renderShoppingPreviewCard = (item: Record<string, unknown>, index: number, badge: string) => {
    const record = itemRecord(item);
    return (
      <AiDraftItemCard
        key={`${badge}-${record.title}-${index}`}
        title={record.title || '未选择食材'}
        summary={quantitySummary(record)}
        status={badge}
        className="ai-shopping-list-preview-card"
      >
        <p>{record.ingredientId ? '已绑定食材库' : '需要从食材库选择'}</p>
        {record.reason ? <p>{record.reason}</p> : null}
      </AiDraftItemCard>
    );
  };

  const renderEditableShoppingItem = (
    item: Record<string, unknown>,
    index: number,
    patchItem: (patch: Record<string, unknown>) => void,
    options: { badge: string; before?: Record<string, unknown>; removable?: boolean; onRemove?: () => void },
  ) => {
    const record = itemRecord(item);
    const selectedIngredient = findIngredientOption(record);
    const usesPresenceQuantity = record.quantityMode === 'not_track_quantity';
    const unitOptions = buildUnitPresetOptions(selectedIngredient?.unit || record.unit)
      .map((unit) => ({ value: unit, label: unit }));

    return (
      <AiDraftItemCard
        key={`${options.badge}-${record.title}-${index}`}
        title={record.title || selectedIngredient?.label || '未选择食材'}
        summary={quantitySummary(record)}
        status={options.badge}
        className="ai-shopping-list-item-card"
        footer={options.removable && !props.readonly ? (
          <button className="ghost-button ai-draft-remove-button" type="button" onClick={options.onRemove}>
            删除采购项
          </button>
        ) : undefined}
      >
        <p>{selectedIngredient?.description || (record.ingredientId ? '已绑定食材库' : '需要从食材库选择')}</p>
        {options.before ? (
          <AiDraftImpactNote tone="plan" title="当前与调整后">
            <p>当前：{[asText(options.before.title), quantitySummary(options.before)].filter(Boolean).join(' · ') || '未记录'}</p>
            <p>调整后：{[record.title, quantitySummary(record)].filter(Boolean).join(' · ') || '待填写'}</p>
          </AiDraftImpactNote>
        ) : null}
        <AiSearchableResourceSelect
          kind="ingredient"
          label="采购食材"
          value={record.ingredientId}
          selectedLabel={record.title}
          placeholder="从食材库选择"
          disabled={props.readonly}
          selectedOption={selectedIngredient}
          loadOptions={props.onLoadResourceOptions}
          onSelect={(option) => patchItem({
            ingredientId: option.id,
            ingredient_id: option.id,
            title: option.label,
            unit: option.unit || record.unit,
          })}
        />
        <ApprovalSelectField
          label="数量模式"
          value={record.quantityMode}
          disabled={props.readonly}
          options={QUANTITY_MODE_OPTIONS}
          icon="type"
          onChange={(next) => patchItem({ quantityMode: next, quantity_mode: next })}
        />
        {usesPresenceQuantity ? (
          <label className="ai-resource-field">
            <span>采购表达</span>
            <input
              className="text-input"
              value={record.displayLabel}
              disabled={props.readonly}
              onChange={(event) => patchItem({
                displayLabel: event.target.value,
                display_label: event.target.value,
              })}
            />
          </label>
        ) : (
          <div className="ai-confirmation-grid ai-confirmation-grid-compact">
            <label className="ai-resource-field">
              <span>数量</span>
              <input
                className="text-input"
                type="number"
                min={0.1}
                step={0.1}
                value={draftNumberInputValue(record.quantity, 1)}
                disabled={props.readonly}
                onChange={(event) => patchItem({ quantity: draftNumberFromInput(event.target.value) })}
              />
            </label>
            <ApprovalComboboxField
              label="单位"
              value={record.unit}
              disabled={props.readonly}
              options={unitOptions}
              placeholder="选择或输入单位"
              icon="type"
              onChange={(unit) => patchItem({ unit })}
            />
          </div>
        )}
        <label className="ai-resource-field ai-confirmation-copy-field">
          <span>采购原因</span>
          <textarea
            className="text-input"
            rows={2}
            value={record.reason}
            disabled={props.readonly}
            placeholder="为什么需要采购"
            onChange={(event) => patchItem({ reason: event.target.value })}
          />
        </label>
      </AiDraftItemCard>
    );
  };

  if (props.status !== 'pending') {
    const entries = hasOperations ? operations : items;
    return (
      <div className="ai-recipe-editor ai-confirmation-editor ai-shopping-list-draft-editor">
        <AiDraftResolvedSummary
          status={resolvedStatus(props.status)}
          title={resolvedTitle(props.status, hasOperations)}
          summary={hasOperations ? `${operations.length} 条清单操作` : `${items.length} 条采购项`}
          className="ai-shopping-list-summary-card"
        >
          <dl className="ai-draft-summary-items">
            {draftSummaryItems.map((item) => (
              <div key={item.label} className="ai-draft-summary-item">
                <dt>{item.label}</dt>
                <dd>{item.value}</dd>
              </div>
            ))}
          </dl>
        </AiDraftResolvedSummary>
        <AiDraftSection
          title="采购项预览"
          description="已处理状态只保留核对摘要，不展示禁用长表单。"
          className="ai-confirmation-item"
        >
          {entries.map((entry, index) => (
            hasOperations
              ? renderShoppingPreviewCard(
                  { ...recordFrom(entry.before), ...recordFrom(entry.payload) },
                  index,
                  actionLabel(asText(entry.action)),
                )
              : renderShoppingPreviewCard(entry, index, '采购项')
          ))}
        </AiDraftSection>
      </div>
    );
  }

  return (
    <div className="ai-recipe-editor ai-confirmation-editor ai-shopping-list-draft-editor">
      <div className="ai-draft-editor-head">
        <div>
          <strong>{hasOperations ? '清单变更' : '创建购物清单'}</strong>
          <span>{hasOperations ? `${operations.length} 条操作` : `${items.length} 条采购项`}</span>
        </div>
      </div>
      <AiDraftSummaryCard
        title={resolvedTitle(props.status, hasOperations)}
        items={draftSummaryItems}
        className="ai-confirmation-item ai-shopping-list-summary-card"
      >
        <AiDraftImpactNote tone="plan" title="确认后">
          {hasOperations
            ? '会按下方操作创建、修改、删除或更新采购状态。'
            : '会写入购物清单，缺失食材需要先创建食材档案。'}
        </AiDraftImpactNote>
      </AiDraftSummaryCard>
      <AiDraftSection
        title={hasOperations ? '清单操作' : '采购项'}
        description={hasOperations ? '按操作逐项核对会写入的购物清单变更。' : '每个采购项都需要绑定食材库中的食材。'}
        className="ai-confirmation-item"
        action={!hasOperations && !props.readonly ? (
          <button
            className="ghost-button ai-draft-add-button"
            type="button"
            onClick={() => addDraftItem('items', {
              title: '',
              ingredient_id: '',
              quantityMode: 'track_quantity',
              quantity_mode: 'track_quantity',
              quantity: 1,
              unit: '份',
              reason: '',
            })}
          >
            添加采购项
          </button>
        ) : null}
      >
        {hasOperations ? operations.map((operation, index) => {
          const action = asText(operation.action);
          const payload = recordFrom(operation.payload);
          const before = recordFrom(operation.before);
          const beforeRecord = itemRecord(before);

          if (action === 'set_done') {
            return (
              <AiDraftItemCard
                key={`${action}-${asText(operation.targetId)}-${index}`}
                title={beforeRecord.title || asText(operation.targetId) || '采购项'}
                summary={quantitySummary(beforeRecord)}
                status={actionLabel(action)}
                className="ai-shopping-list-item-card"
              >
                <p>状态：{doneLabel(before.done)} → {doneLabel(payload.done)}</p>
                <ApprovalSelectField
                  label="采购状态"
                  value={String(Boolean(payload.done))}
                  disabled={props.readonly}
                  options={DONE_OPTIONS}
                  icon="type"
                  onChange={(done) => updateOperationPayloadItem(index, { done: done === 'true' })}
                />
                <label className="ai-resource-field ai-confirmation-copy-field">
                  <span>状态说明</span>
                  <textarea
                    className="text-input"
                    rows={2}
                    value={asText(payload.reason)}
                    disabled={props.readonly}
                    placeholder="可选，说明状态变更"
                    onChange={(event) => updateOperationPayloadItem(index, { reason: event.target.value })}
                  />
                </label>
              </AiDraftItemCard>
            );
          }

          if (action === 'delete') {
            return (
              <AiDraftItemCard
                key={`${action}-${asText(operation.targetId)}-${index}`}
                title={beforeRecord.title || asText(operation.targetId) || '采购项'}
                summary={quantitySummary(beforeRecord)}
                status={actionLabel(action)}
                className="ai-shopping-list-item-card is-danger"
              >
                <p>确认后只删除这条采购项，不影响食材档案和库存。</p>
                <AiDraftImpactNote tone="danger" title="删除影响">
                  <p>删除采购项：{[beforeRecord.title, quantitySummary(beforeRecord), doneLabel(before.done)].filter(Boolean).join(' · ')}</p>
                  <p>不会删除食材档案，也不会调整库存数量。</p>
                </AiDraftImpactNote>
              </AiDraftItemCard>
            );
          }

          return renderEditableShoppingItem(payload, index, (patch) => updateOperationPayloadItem(index, patch), {
            badge: actionLabel(action),
            before: action === 'update' ? before : undefined,
          });
        }) : items.map((item, index) => renderEditableShoppingItem(item, index, (patch) => updateDraftItem('items', index, patch), {
          badge: '新增',
          removable: items.length > 1,
          onRemove: () => removeDraftItem('items', index),
        }))}
      </AiDraftSection>
    </div>
  );
}
