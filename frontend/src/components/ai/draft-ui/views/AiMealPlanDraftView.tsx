import type { AiApprovalRequest } from '../../../../api/types';
import {
  AiSearchableResourceSelect,
  ApprovalSelectField,
  IngredientQuantityPicker,
  normalizeMealPlanIngredientItems,
  ResourceSelectIcon,
} from '../../AiApprovalFields';
import type { AiResourceOption, AiResourceOptionLoader } from '../../AiApprovalFields';
import { asDraftArray, asText } from '../../aiDraftValueUtils';
import { AiDraftImpactNote } from '../AiDraftImpactNote';
import { AiDraftItemCard } from '../AiDraftItemCard';
import { AiDraftResolvedSummary } from '../AiDraftResolvedSummary';
import { AiDraftSection } from '../AiDraftSection';
import { AiDraftSummaryCard } from '../AiDraftSummaryCard';

const MEAL_TYPE_OPTIONS = [
  { value: 'breakfast', label: '早餐' },
  { value: 'lunch', label: '午餐' },
  { value: 'dinner', label: '晚餐' },
  { value: 'snack', label: '加餐' },
];

const PLAN_STATUS_OPTIONS = [
  { value: 'planned', label: '计划中' },
  { value: 'cooked', label: '已完成' },
  { value: 'skipped', label: '已跳过' },
];

type MissingIngredient = { ingredientId: string; name: string; quantity: number | ''; unit: string };

function recordFrom(value: unknown) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function mealTypeLabel(value: unknown) {
  const normalized = asText(value).replace(/^MealType\./i, '').toLowerCase();
  return MEAL_TYPE_OPTIONS.find((option) => option.value === normalized)?.label ?? asText(value);
}

function mealPlanActionLabel(action: string) {
  switch (action) {
    case 'create': return '新增';
    case 'update': return '修改';
    case 'set_status': return '状态变更';
    case 'delete': return '删除';
    default: return action || '计划';
  }
}

function mealPlanStatusLabel(value: unknown) {
  switch (asText(value, 'planned')) {
    case 'planned': return '计划中';
    case 'cooked': return '已完成';
    case 'skipped': return '已跳过';
    default: return asText(value) || '计划中';
  }
}

function mealPlanItemRecord(value: Record<string, unknown>) {
  return {
    ...value,
    date: asText(value.date),
    mealType: asText(value.mealType, 'dinner'),
    title: asText(value.title) || asText(value.foodName) || asText(value.name),
    foodId: asText(value.foodId) || asText(value.food_id),
    reason: asText(value.reason),
  };
}

function mealPlanMissingIngredientCount(value: Record<string, unknown>) {
  const detailedItems = asDraftArray(value.missingIngredientItems ?? value.missing_ingredient_items);
  if (detailedItems.length > 0) return detailedItems.length;
  const simpleItems = value.missingIngredients ?? value.missing_ingredients;
  return Array.isArray(simpleItems) ? simpleItems.length : 0;
}

function mealPlanSummaryItems(items: Record<string, unknown>[], operations: Record<string, unknown>[]) {
  const planItems = operations.length > 0
    ? operations.map((operation) => mealPlanItemRecord({ ...recordFrom(operation.before), ...recordFrom(operation.payload) }))
    : items.map(mealPlanItemRecord);
  const dates = new Set(planItems.map((item) => item.date).filter(Boolean));
  const mealTypes = new Set(planItems.map((item) => mealTypeLabel(item.mealType)).filter(Boolean));
  const missingCount = planItems.reduce((sum, item) => sum + mealPlanMissingIngredientCount(item), 0);
  const actionCounts = operations.reduce<Record<string, number>>((counts, operation) => {
    const label = mealPlanActionLabel(asText(operation.action));
    counts[label] = (counts[label] ?? 0) + 1;
    return counts;
  }, {});
  const changeSummary = operations.length > 0
    ? Object.entries(actionCounts).map(([label, count]) => `${label}${count}`).join('、')
    : '新增计划';
  return [
    { label: '计划项', value: `${operations.length > 0 ? operations.length : items.length} 项` },
    { label: '涉及天数', value: dates.size > 0 ? `${dates.size} 天` : '未填写' },
    { label: '餐别', value: mealTypes.size > 0 ? Array.from(mealTypes).join('、') : '未填写' },
    { label: '缺失食材', value: missingCount > 0 ? `${missingCount} 项` : '无' },
    { label: '变更', value: changeSummary },
  ];
}

function resolvedTitle(status: AiApprovalRequest['status'], hasOperations: boolean) {
  if (status === 'approved') return hasOperations ? '餐食计划变更已确认' : '餐食计划已确认';
  if (status === 'rejected') return '未写入的餐食计划草稿';
  if (status === 'expired') return '已过期的餐食计划草稿';
  return hasOperations ? '待确认计划变更' : '待确认餐食计划';
}

function resolvedStatus(status: string): 'approved' | 'rejected' | 'expired' | 'cancelled' | 'canceled' {
  if (status === 'approved' || status === 'rejected' || status === 'expired' || status === 'cancelled' || status === 'canceled') {
    return status;
  }
  return 'expired';
}

export function AiMealPlanDraftView(props: {
  draft: Record<string, unknown>;
  readonly: boolean;
  status: AiApprovalRequest['status'];
  foodOptions: readonly AiResourceOption[];
  ingredientOptions: readonly AiResourceOption[];
  onDraftChange: (next: Record<string, unknown>) => void;
  onLoadResourceOptions: AiResourceOptionLoader;
}) {
  const operations = asDraftArray(props.draft.operations);
  const items = asDraftArray(props.draft.items);
  const hasOperations = operations.length > 0;
  const summaryItems = mealPlanSummaryItems(items, operations);
  const updateDraftItem = (key: string, index: number, patch: Record<string, unknown>) => {
    const currentItems = asDraftArray(props.draft[key]);
    props.onDraftChange({
      ...props.draft,
      [key]: currentItems.map((item, itemIndex) => (itemIndex === index ? { ...item, ...patch } : item)),
    });
  };
  const addDraftItem = (key: string, item: Record<string, unknown>) => {
    props.onDraftChange({ ...props.draft, [key]: [...asDraftArray(props.draft[key]), item] });
  };
  const removeDraftItem = (key: string, index: number) => {
    const currentItems = asDraftArray(props.draft[key]);
    if (currentItems.length <= 1) return;
    props.onDraftChange({ ...props.draft, [key]: currentItems.filter((_, itemIndex) => itemIndex !== index) });
  };
  const updateOperationPayloadItem = (index: number, patch: Record<string, unknown>) => {
    props.onDraftChange({
      ...props.draft,
      operations: operations.map((operation, operationIndex) => (
        operationIndex === index ? { ...operation, payload: { ...recordFrom(operation.payload), ...patch } } : operation
      )),
    });
  };
  const renderMissingIngredients = (item: Record<string, unknown>, onChange: (nextItems: MissingIngredient[]) => void) => {
    const normalizedItems = normalizeMealPlanIngredientItems(
      item.missingIngredientItems ?? item.missing_ingredient_items ?? item.missingIngredients ?? item.missing_ingredients,
      [...props.ingredientOptions],
    );
    return (
      <AiDraftImpactNote tone={normalizedItems.length > 0 ? 'warning' : 'neutral'} title="缺料提醒">
        <p>这里仅作为计划缺料提醒，不会登记库存或加入购物清单。</p>
        <IngredientQuantityPicker
          label="缺失食材"
          items={normalizedItems}
          disabled={props.readonly}
          selectedOptions={[...props.ingredientOptions]}
          loadOptions={props.onLoadResourceOptions}
          onChange={onChange}
        />
      </AiDraftImpactNote>
    );
  };
  const renderPlanPreviewCard = (item: Record<string, unknown>, index: number, badge: string) => {
    const record = mealPlanItemRecord(item);
    return (
      <AiDraftItemCard
        key={`${badge}-${record.date}-${record.title}-${index}`}
        title={record.title || '未选择食物'}
        summary={[record.date, mealTypeLabel(record.mealType)].filter(Boolean).join(' · ') || '待安排'}
        status={badge}
        className="ai-meal-plan-preview-card"
      >
        <p>{record.foodId ? '已绑定食物库' : '需要从食物库选择'}</p>
        {record.reason ? <p className="ai-meal-plan-preview-note">{record.reason}</p> : null}
      </AiDraftItemCard>
    );
  };
  const renderEditablePlanItem = (
    item: Record<string, unknown>,
    index: number,
    patchItem: (patch: Record<string, unknown>) => void,
    options: { badge: string; before?: Record<string, unknown>; removable?: boolean; onRemove?: () => void },
  ) => {
    const record = mealPlanItemRecord(item);
    const selectedFood = props.foodOptions.find((option) => option.id === record.foodId) ?? null;
    return (
      <AiDraftItemCard
        key={`${options.badge}-${record.date}-${record.title}-${index}`}
        title={record.title || selectedFood?.label || '未选择食物'}
        summary={[record.date, mealTypeLabel(record.mealType)].filter(Boolean).join(' · ') || '待安排'}
        status={options.badge}
        className="ai-meal-plan-item-card"
        footer={options.removable && !props.readonly ? (
          <button className="ghost-button ai-draft-remove-button" type="button" onClick={options.onRemove}>删除计划项</button>
        ) : undefined}
      >
        <p>{selectedFood?.description || (record.foodId ? '已绑定食物库' : '需要从食物库选择')}</p>
        {options.before ? (
          <AiDraftImpactNote tone="plan" title="当前与调整后">
            <p>当前：{[asText(options.before.date), mealTypeLabel(options.before.mealType), asText(options.before.title)].filter(Boolean).join(' · ') || '未记录'}</p>
            <p>调整后：{[record.date, mealTypeLabel(record.mealType), record.title].filter(Boolean).join(' · ') || '待填写'}</p>
          </AiDraftImpactNote>
        ) : null}
        <div className="ai-meal-plan-item-top">
          <label className="ai-resource-field ai-resource-field-date">
            <span>日期</span>
            <div className="ai-resource-select">
              <ResourceSelectIcon kind="calendar" />
              <input type="date" value={record.date} disabled={props.readonly} onChange={(event) => patchItem({ date: event.target.value })} />
            </div>
          </label>
          <ApprovalSelectField label="餐别" value={record.mealType} disabled={props.readonly} options={MEAL_TYPE_OPTIONS} icon="meal" onChange={(mealType) => patchItem({ mealType })} />
        </div>
        <AiSearchableResourceSelect
          kind="food"
          label="食物"
          value={record.foodId}
          selectedLabel={record.title}
          placeholder="搜索食物库"
          disabled={props.readonly}
          selectedOption={selectedFood}
          loadOptions={props.onLoadResourceOptions}
          onSelect={(option) => patchItem({ foodId: option.id, food_id: option.id, title: option.label })}
        />
        {renderMissingIngredients(item, (nextItems) => patchItem({
          missingIngredientItems: nextItems,
          missingIngredients: nextItems.map((ingredient) => ingredient.name),
        }))}
        <label className="ai-resource-field ai-meal-plan-reason-field">
          <span>安排原因</span>
          <textarea className="text-input" rows={2} value={record.reason} disabled={props.readonly} placeholder="安排原因" onChange={(event) => patchItem({ reason: event.target.value })} />
        </label>
      </AiDraftItemCard>
    );
  };

  if (props.status !== 'pending') {
    const previews = hasOperations ? operations : items;
    return (
      <div className="ai-recipe-editor ai-confirmation-editor ai-meal-plan-draft-editor">
        <AiDraftResolvedSummary
          status={resolvedStatus(props.status)}
          title={resolvedTitle(props.status, hasOperations)}
          summary={hasOperations ? `${operations.length} 条计划操作` : `${items.length} 条计划项`}
          className="ai-meal-plan-summary-card"
        >
          <dl className="ai-draft-summary-items">
            {summaryItems.map((item) => (
              <div key={item.label} className="ai-draft-summary-item"><dt>{item.label}</dt><dd>{item.value}</dd></div>
            ))}
          </dl>
        </AiDraftResolvedSummary>
        <AiDraftSection title="计划项预览" description="已处理状态只保留核对摘要，不展示禁用长表单。" className="ai-confirmation-item">
          {previews.map((entry, index) => {
            if (!hasOperations) return renderPlanPreviewCard(entry, index, '计划');
            const operation = entry;
            return renderPlanPreviewCard({ ...recordFrom(operation.before), ...recordFrom(operation.payload) }, index, mealPlanActionLabel(asText(operation.action)));
          })}
        </AiDraftSection>
      </div>
    );
  }

  return (
    <div className="ai-recipe-editor ai-confirmation-editor ai-meal-plan-draft-editor">
      <div className="ai-draft-editor-head">
        <div>
          <strong>{hasOperations ? '计划变更' : '创建餐食计划'}</strong>
          <span>{hasOperations ? `${operations.length} 条操作` : `${items.length} 条计划`}</span>
        </div>
      </div>
      <AiDraftSummaryCard
        title={resolvedTitle(props.status, hasOperations)}
        items={summaryItems}
        className="ai-confirmation-item ai-meal-plan-summary-card"
      >
        <AiDraftImpactNote tone="plan" title="确认后">
          {hasOperations ? '会按下方操作创建、修改、删除或更新计划状态。' : '会写入正式餐食计划，不会创建新食物资料。'}
        </AiDraftImpactNote>
      </AiDraftSummaryCard>
      <AiDraftSection
        title="计划项"
        description={hasOperations ? '按操作逐项核对会写入的计划变更。' : '每个计划项都需要绑定食物库中的食物。'}
        className="ai-confirmation-item"
        action={!hasOperations && !props.readonly ? (
          <button className="ghost-button ai-draft-add-button" type="button" onClick={() => addDraftItem('items', { date: new Date().toISOString().slice(0, 10), mealType: 'dinner', title: '', foodId: '', reason: '', missingIngredients: [] })}>添加计划</button>
        ) : null}
      >
        {hasOperations ? operations.map((operation, index) => {
          const action = asText(operation.action);
          const payload = recordFrom(operation.payload);
          const before = recordFrom(operation.before);
          if (action === 'set_status') {
            return (
              <AiDraftItemCard
                key={`${action}-${asText(operation.targetId)}-${index}`}
                title={asText(before.title) || asText(operation.targetId) || '计划项'}
                summary={[asText(before.date), mealTypeLabel(before.mealType)].filter(Boolean).join(' · ') || '计划项'}
                status={mealPlanActionLabel(action)}
                className="ai-meal-plan-item-card"
              >
                <p>状态：{mealPlanStatusLabel(before.status)} → {mealPlanStatusLabel(payload.status)}</p>
                <ApprovalSelectField label="计划状态" value={asText(payload.status, 'planned')} disabled={props.readonly} options={PLAN_STATUS_OPTIONS} icon="meal" onChange={(status) => updateOperationPayloadItem(index, { status })} />
                <label className="ai-resource-field ai-meal-plan-reason-field">
                  <span>状态说明</span>
                  <textarea className="text-input" rows={2} value={asText(payload.reason)} disabled={props.readonly} placeholder="可选，说明完成或跳过原因" onChange={(event) => updateOperationPayloadItem(index, { reason: event.target.value })} />
                </label>
              </AiDraftItemCard>
            );
          }
          if (action === 'delete') {
            return (
              <AiDraftItemCard
                key={`${action}-${asText(operation.targetId)}-${index}`}
                title={asText(before.title) || asText(operation.targetId) || '计划项'}
                summary={[asText(before.date), mealTypeLabel(before.mealType)].filter(Boolean).join(' · ') || '计划项'}
                status={mealPlanActionLabel(action)}
                className="ai-meal-plan-item-card is-danger"
              >
                <p>确认后只删除这条计划，不删除食物资料。</p>
                <AiDraftImpactNote tone="danger" title="删除影响">
                  <p>删除计划项：{[asText(before.date), mealTypeLabel(before.mealType), asText(before.title)].filter(Boolean).join(' · ') || asText(operation.targetId)}</p>
                  <p>不会删除食物资料；如有关联餐食记录，请在确认前核对。</p>
                </AiDraftImpactNote>
                <label className="ai-resource-field ai-meal-plan-reason-field">
                  <span>删除原因</span>
                  <textarea className="text-input" rows={2} value={asText(payload.reason)} disabled={props.readonly} placeholder="可选，说明删除原因" onChange={(event) => updateOperationPayloadItem(index, { reason: event.target.value })} />
                </label>
              </AiDraftItemCard>
            );
          }
          return renderEditablePlanItem(payload, index, (patch) => updateOperationPayloadItem(index, patch), {
            badge: mealPlanActionLabel(action),
            before: action === 'update' ? before : undefined,
          });
        }) : items.map((item, index) => renderEditablePlanItem(item, index, (patch) => updateDraftItem('items', index, patch), {
          badge: '新增',
          removable: items.length > 1,
          onRemove: () => removeDraftItem('items', index),
        }))}
      </AiDraftSection>
    </div>
  );
}
