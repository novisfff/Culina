import type { AiApprovalRequest } from '../../../../api/types';
import { StarRatingInput } from '../../../ui-kit';
import {
  AiSearchableResourceSelect,
  ApprovalComboboxField,
  ApprovalSelectField,
  ResourceSelectIcon,
} from '../../AiApprovalFields';
import type { AiResourceOption, AiResourceOptionLoader } from '../../AiApprovalFields';
import {
  asDraftArray,
  asNumber,
  asText,
  draftNumberFromInput,
  draftNumberInputValue,
} from '../../aiDraftValueUtils';
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

const MOOD_OPTIONS = [
  { value: '满足', label: '满足' },
  { value: '清淡', label: '清淡' },
  { value: '匆忙', label: '匆忙' },
  { value: '聚餐', label: '聚餐' },
  { value: '孩子喜欢', label: '孩子喜欢' },
];

const READY_LIKE_FOOD_TYPES = new Set(['readyMade', 'instant', 'packaged']);

function recordFrom(value: unknown) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function mealTypeLabel(value: unknown) {
  const text = asText(value);
  const normalized = text.replace(/^MealType\./i, '').toLowerCase();
  return MEAL_TYPE_OPTIONS.find((option) => option.value === normalized)?.label ?? text;
}

function formatServingCount(value: unknown) {
  const numeric = asNumber(value, 0);
  return Number.isInteger(numeric) ? String(numeric) : String(Number(numeric.toFixed(1)));
}

function ratingInputValue(value: unknown) {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return asText(value);
}

function ratingDisplayText(value: unknown) {
  const rating = typeof value === 'number' && Number.isFinite(value) ? value : Number(asText(value));
  if (!Number.isFinite(rating) || rating <= 0) return '未评分';
  return `${rating.toFixed(1).replace(/\.0$/, '')} 分`;
}

function countLabel(value: unknown, unit: string) {
  const count = Array.isArray(value) ? value.length : 0;
  return count > 0 ? `${count} ${unit}` : '无';
}

function mealLogFoodsFromDraft(value: unknown) {
  return asDraftArray(value).map((item) => ({
    ...item,
    foodId: asText(item.foodId) || asText(item.food_id),
    name: asText(item.name) || asText(item.foodName),
    servings: asNumber(item.servings, 1),
    note: asText(item.note),
    foodType: asText(item.foodType),
    deductStock: item.deductStock === true,
    stockQuantity: asText(item.stockQuantity),
    stockUnit: asText(item.stockUnit),
    stockCurrentQuantity: asText(item.stockCurrentQuantity),
    stockAfterQuantity: asText(item.stockAfterQuantity),
  }));
}

function mealLogSummaryItems(record: Record<string, unknown>) {
  const foods = mealLogFoodsFromDraft(record.foods);
  const totalServings = foods.reduce((sum, food) => sum + asNumber(food.servings, 0), 0);
  return [
    { label: '日期', value: asText(record.date) || '未填写' },
    { label: '餐别', value: mealTypeLabel(record.mealType) || '未填写' },
    { label: '食物', value: `${foods.length} 项` },
    { label: '总份数', value: `${formatServingCount(totalServings)} 份` },
    { label: '参与人', value: countLabel(record.participantUserIds, '人') },
    { label: '照片', value: countLabel(record.mediaIds, '张') },
    { label: '关联计划', value: asText(record.planItemId) ? '已关联' : '未关联' },
    { label: '心情', value: asText(record.mood) || '未填写' },
  ];
}

function actionLabel(action: string) {
  if (action === 'update_details') return '补充';
  if (action === 'rate_food') return '评分';
  return '创建';
}

function statusTitle(status: AiApprovalRequest['status'], action: string) {
  const label = actionLabel(action);
  if (status === 'approved') return `${label}餐食记录已确认`;
  if (status === 'rejected') return '未写入的餐食记录草稿';
  if (status === 'expired') return '已过期的餐食记录草稿';
  return `${label}餐食记录`;
}

function pendingTitle(action: string) {
  if (action === 'update_details') return '补充餐食记录';
  if (action === 'rate_food') return '更新餐食评分';
  return '待确认餐食记录';
}

function resolvedStatus(status: string): 'approved' | 'rejected' | 'expired' | 'cancelled' | 'canceled' {
  if (status === 'approved' || status === 'rejected' || status === 'expired' || status === 'cancelled' || status === 'canceled') {
    return status;
  }
  return 'expired';
}

export function AiMealLogDraftView(props: {
  draft: Record<string, unknown>;
  readonly: boolean;
  status: AiApprovalRequest['status'];
  foodOptions: readonly AiResourceOption[];
  onDraftChange: (next: Record<string, unknown>) => void;
  onLoadResourceOptions: AiResourceOptionLoader;
}) {
  const action = asText(props.draft.action);
  const before = recordFrom(props.draft.before);
  const payload = recordFrom(props.draft.payload);
  const isCreate = !action || action === 'create';
  const createRecord = action === 'create' ? payload : props.draft;
  const updateRecord = { ...before, ...payload };

  const updateCreateRecord = (patch: Record<string, unknown>) => {
    if (action === 'create') {
      props.onDraftChange({ ...props.draft, payload: { ...payload, ...patch } });
      return;
    }
    props.onDraftChange({ ...props.draft, ...patch });
  };

  const updatePayload = (patch: Record<string, unknown>) => {
    props.onDraftChange({ ...props.draft, payload: { ...payload, ...patch } });
  };

  const renderReferenceChips = (label: string, value: unknown, emptyLabel: string) => {
    const values = Array.isArray(value) ? value.map(String).filter(Boolean) : [];
    return (
      <div className="ai-meal-log-reference-group">
        <span>{label}</span>
        <div className="ai-meal-log-reference-chips">
          {values.length > 0
            ? values.map((item) => <em key={item}>{item}</em>)
            : <em className="is-empty">{emptyLabel}</em>}
        </div>
      </div>
    );
  };

  const renderSummaryNotes = (record: Record<string, unknown>) => (
    <>
      {asText(record.notes) ? <p className="ai-meal-log-summary-note">{asText(record.notes)}</p> : null}
    </>
  );

  const renderResolvedSummary = (record: Record<string, unknown>, recordAction: string) => (
    <AiDraftResolvedSummary
      status={resolvedStatus(props.status)}
      title={statusTitle(props.status, recordAction)}
      summary={[asText(record.date), mealTypeLabel(record.mealType)].filter(Boolean).join(' · ') || '餐食记录'}
      className="ai-meal-log-summary-card"
    >
      <dl className="ai-draft-summary-items">
        {mealLogSummaryItems(record).map((item) => (
          <div key={item.label} className="ai-draft-summary-item">
            <dt>{item.label}</dt>
            <dd>{item.value}</dd>
          </div>
        ))}
      </dl>
      {renderSummaryNotes(record)}
    </AiDraftResolvedSummary>
  );

  const renderPendingSummary = (record: Record<string, unknown>, recordAction: string) => (
    <AiDraftSummaryCard
      title={pendingTitle(recordAction)}
      items={mealLogSummaryItems(record)}
      className="ai-confirmation-item ai-meal-log-summary-card"
    >
      <p className="ai-meal-log-summary-context">
        {[asText(record.date), mealTypeLabel(record.mealType)].filter(Boolean).join(' · ') || '餐食记录'}
      </p>
      <AiDraftImpactNote tone="plan" title="确认后">
        <p>{recordAction === 'update_details' ? '只补充本餐详情，不会修改食物项。' : recordAction === 'rate_food' ? '会更新下方食物评分。' : '会写入这条餐食记录。'}</p>
      </AiDraftImpactNote>
      {renderSummaryNotes(record)}
    </AiDraftSummaryCard>
  );

  const renderCreateEditor = () => {
    const foods = mealLogFoodsFromDraft(createRecord.foods);
    const updateFood = (index: number, patch: Record<string, unknown>) => {
      updateCreateRecord({
        foods: foods.map((food, foodIndex) => (
          foodIndex === index ? { ...food, ...patch } : food
        )),
      });
    };
    const addFood = () => {
      updateCreateRecord({ foods: [...foods, { foodId: '', name: '', servings: 1, note: '' }] });
    };
    const removeFood = (index: number) => {
      if (foods.length <= 1) return;
      updateCreateRecord({ foods: foods.filter((_, foodIndex) => foodIndex !== index) });
    };

    return (
      <>
        {renderPendingSummary(createRecord, action)}
        <AiDraftSection
          title="餐食信息"
          description="确认日期、餐别和是否关联计划。"
          className="ai-confirmation-item"
        >
          <div className="ai-confirmation-grid">
            <label className="ai-resource-field ai-resource-field-date">
              <span>日期</span>
              <div className="ai-resource-select">
                <ResourceSelectIcon kind="calendar" />
                <input
                  type="date"
                  value={asText(createRecord.date)}
                  disabled={props.readonly}
                  onChange={(event) => updateCreateRecord({ date: event.target.value })}
                />
              </div>
            </label>
            <ApprovalSelectField
              label="餐别"
              value={asText(createRecord.mealType, 'dinner')}
              disabled={props.readonly}
              options={MEAL_TYPE_OPTIONS}
              icon="meal"
              onChange={(mealType) => updateCreateRecord({ mealType })}
            />
          </div>
          <p className="ai-approval-compare-copy">
            关联计划：{asText(createRecord.planItemId) ? '已关联计划项' : '未关联计划'}
          </p>
        </AiDraftSection>
        <AiDraftSection
          title="食物项"
          description="每个食物都必须从食物库选择，新食物先创建食物资料。"
          className="ai-confirmation-item"
          action={!props.readonly ? (
            <button className="ghost-button ai-draft-add-button" type="button" onClick={addFood}>
              添加食物
            </button>
          ) : null}
        >
          {foods.map((food, index) => {
            const selectedFood = props.foodOptions.find((option) => (
              option.id === asText(food.foodId) || option.label === asText(food.name)
            )) ?? null;
            const foodType = asText(food.foodType) || selectedFood?.foodType || '';
            const isReadyLike = READY_LIKE_FOOD_TYPES.has(foodType);
            const stockUnit = asText(food.stockUnit) || selectedFood?.unit || '';
            const stockCurrentQuantity = asText(food.stockCurrentQuantity)
              || (selectedFood?.stockQuantity !== null && selectedFood?.stockQuantity !== undefined
                ? String(selectedFood.stockQuantity)
                : '');
            const currentStock = Number(stockCurrentQuantity);
            const requestedStock = Number(asText(food.stockQuantity));
            const afterStock = Number.isFinite(currentStock) && Number.isFinite(requestedStock)
              ? String(Number(Math.max(0, currentStock - requestedStock).toFixed(1)))
              : '';

            return (
              <AiDraftItemCard
                key={`${asText(food.name)}-${index}`}
                title={asText(food.name) || selectedFood?.label || `食物 ${index + 1}`}
                summary={`食物 ${index + 1} · ${formatServingCount(food.servings)} 份`}
                status={formatServingCount(food.servings) + ' 份'}
                className="ai-meal-log-food-item"
                footer={!props.readonly && foods.length > 1 ? (
                  <button className="ghost-button ai-draft-remove-button" type="button" onClick={() => removeFood(index)}>
                    删除食物
                  </button>
                ) : undefined}
              >
                <p>{selectedFood?.description || (asText(food.foodId) ? '已绑定食物库' : '需要从食物库选择')}</p>
                <AiSearchableResourceSelect
                  kind="food"
                  label="食物"
                  value={asText(food.foodId)}
                  selectedLabel={asText(food.name)}
                  placeholder="从食物库选择"
                  disabled={props.readonly}
                  selectedOption={selectedFood}
                  loadOptions={props.onLoadResourceOptions}
                  onSelect={(option) => updateFood(index, {
                    foodId: option.id,
                    food_id: option.id,
                    name: option.label,
                    foodType: option.foodType || '',
                    deductStock: false,
                    stockQuantity: undefined,
                    stockUnit: option.unit || '',
                    stockCurrentQuantity: option.stockQuantity !== null && option.stockQuantity !== undefined
                      ? String(option.stockQuantity)
                      : '',
                    stockAfterQuantity: undefined,
                  })}
                />
                <label className="ai-resource-field">
                  <span>份数</span>
                  <input
                    className="text-input"
                    type="number"
                    min={0.1}
                    step={0.1}
                    value={draftNumberInputValue(food.servings, 1)}
                    disabled={props.readonly}
                    onChange={(event) => updateFood(index, { servings: draftNumberFromInput(event.target.value) })}
                  />
                </label>
                <label className="ai-resource-field ai-confirmation-copy-field">
                  <span>食物备注</span>
                  <textarea
                    className="text-input"
                    rows={2}
                    value={asText(food.note)}
                    disabled={props.readonly}
                    placeholder="这份食物的补充说明"
                    onChange={(event) => updateFood(index, { note: event.target.value })}
                  />
                </label>
                {isReadyLike ? (
                  <AiDraftImpactNote tone="warning" title="库存扣减说明" className="ai-meal-log-stock-control">
                    <label className="ai-meal-log-stock-toggle">
                      <input
                        type="checkbox"
                        checked={food.deductStock}
                        disabled={props.readonly || !stockUnit || !Number.isFinite(currentStock) || currentStock <= 0}
                        onChange={(event) => {
                          const enabled = event.target.checked;
                          const defaultQuantity = asText(food.stockQuantity) || '1';
                          updateFood(index, {
                            deductStock: enabled,
                            stockQuantity: enabled ? defaultQuantity : undefined,
                            stockUnit,
                            stockCurrentQuantity,
                            stockAfterQuantity: enabled
                              ? String(Number(Math.max(0, currentStock - Number(defaultQuantity)).toFixed(1)))
                              : undefined,
                          });
                        }}
                      />
                      <span>同时扣减库存</span>
                    </label>
                    <p>
                      {stockUnit && stockCurrentQuantity
                        ? `当前库存 ${stockCurrentQuantity} ${stockUnit}`
                        : '当前食物尚未设置可扣减库存'}
                    </p>
                    {food.deductStock ? (
                      <div className="ai-meal-log-stock-fields">
                        <label className="ai-resource-field">
                          <span>扣减数量</span>
                          <input
                            className="text-input"
                            type="number"
                            min={0.1}
                            max={Number.isFinite(currentStock) ? currentStock : undefined}
                            step={0.1}
                            value={asText(food.stockQuantity, '1')}
                            disabled={props.readonly}
                            onChange={(event) => {
                              const stockQuantity = event.target.value;
                              const quantity = Number(stockQuantity);
                              updateFood(index, {
                                stockQuantity,
                                stockAfterQuantity: Number.isFinite(currentStock) && Number.isFinite(quantity)
                                  ? String(Number(Math.max(0, currentStock - quantity).toFixed(1)))
                                  : '',
                              });
                            }}
                          />
                        </label>
                        <div className="ai-meal-log-stock-unit">
                          <span>库存单位</span>
                          <strong>{stockUnit}</strong>
                        </div>
                        <p>确认后预计剩余 {afterStock || asText(food.stockAfterQuantity)} {stockUnit}</p>
                      </div>
                    ) : null}
                  </AiDraftImpactNote>
                ) : null}
              </AiDraftItemCard>
            );
          })}
        </AiDraftSection>
        <AiDraftSection
          title="参与人和照片"
          description="当前审批内先只读核对成员和照片引用。"
          className="ai-confirmation-item"
        >
          <div className="ai-meal-log-reference-grid">
            {renderReferenceChips('参与人', createRecord.participantUserIds, '未指定')}
            {renderReferenceChips('照片', createRecord.mediaIds, '无照片')}
          </div>
        </AiDraftSection>
        <AiDraftSection
          title="备注与心情"
          description="补充这一餐的主观记录。"
          className="ai-confirmation-item"
        >
          <ApprovalComboboxField
            label="心情"
            value={asText(createRecord.mood)}
            disabled={props.readonly}
            options={MOOD_OPTIONS}
            placeholder="选择或输入心情"
            icon="type"
            onChange={(mood) => updateCreateRecord({ mood })}
          />
          <label className="ai-resource-field ai-confirmation-copy-field">
            <span>餐食备注</span>
            <textarea
              className="text-input"
              rows={3}
              value={asText(createRecord.notes)}
              disabled={props.readonly}
              placeholder="记录这一餐的整体情况"
              onChange={(event) => updateCreateRecord({ notes: event.target.value })}
            />
          </label>
        </AiDraftSection>
      </>
    );
  };

  const renderUpdateDetailsEditor = () => (
    <>
      {renderPendingSummary(updateRecord, action)}
      <AiDraftSection
        title="参与人和照片"
        description="当前审批内先只读核对成员和照片引用。"
        className="ai-confirmation-item"
      >
        <div className="ai-meal-log-reference-grid">
          {renderReferenceChips('参与人', payload.participantUserIds, '不变更')}
          {renderReferenceChips('照片', payload.mediaIds, '不变更')}
        </div>
      </AiDraftSection>
      <AiDraftSection
        title="备注与心情"
        description="只补充餐食记录细节，不修改食物项。"
        className="ai-confirmation-item"
      >
        <ApprovalComboboxField
          label="心情"
          value={asText(payload.mood)}
          disabled={props.readonly}
          options={MOOD_OPTIONS}
          placeholder="选择或输入心情"
          icon="type"
          onChange={(mood) => updatePayload({ mood })}
        />
        <label className="ai-resource-field ai-confirmation-copy-field">
          <span>备注</span>
          <textarea
            className="text-input"
            rows={3}
            value={asText(payload.notes)}
            disabled={props.readonly}
            placeholder="补充这一餐的说明"
            onChange={(event) => updatePayload({ notes: event.target.value })}
          />
        </label>
      </AiDraftSection>
    </>
  );

  const renderRatingEditor = () => {
    const foodRatings = asDraftArray(payload.foodEntryRatings);
    return (
      <>
        {renderPendingSummary(updateRecord, action)}
        <AiDraftSection
          title="食物评分"
          description="逐项确认本次评分变化。"
          className="ai-confirmation-item"
        >
          {foodRatings.map((item, index) => {
            const food = asDraftArray(before.foods).find((entry) => asText(entry.id) === asText(item.id));
            return (
              <AiDraftItemCard
                key={`${asText(item.id)}-${index}`}
                title={asText(food?.foodName) || asText(item.id) || '食物项'}
                summary={`当前评分 ${ratingDisplayText(food?.rating)} · 新评分 ${ratingDisplayText(item.rating)}`}
                status="评分"
                className="ai-meal-log-rating-card"
              >
                <p className="ai-approval-compare-copy">
                  {asText(food?.foodName) || asText(item.id)} · 当前评分 {ratingDisplayText(food?.rating)} · 新评分 {ratingDisplayText(item.rating)}
                </p>
                <div className="ai-resource-field ai-rating-field">
                  <span>新评分</span>
                  <StarRatingInput
                    value={ratingInputValue(item.rating)}
                    disabled={props.readonly}
                    onChange={(value) => updatePayload({
                      foodEntryRatings: foodRatings.map((ratingItem, ratingIndex) => (
                        ratingIndex === index
                          ? { ...ratingItem, rating: Number(value) || null }
                          : ratingItem
                      )),
                    })}
                  />
                </div>
                <label className="ai-resource-field ai-confirmation-copy-field">
                  <span>评分备注</span>
                  <textarea
                    className="text-input"
                    rows={2}
                    value={asText(item.note)}
                    disabled={props.readonly}
                    placeholder="可选，记录这次评分原因"
                    onChange={(event) => updatePayload({
                      foodEntryRatings: foodRatings.map((ratingItem, ratingIndex) => (
                        ratingIndex === index
                          ? { ...ratingItem, note: event.target.value }
                          : ratingItem
                      )),
                    })}
                  />
                </label>
              </AiDraftItemCard>
            );
          })}
        </AiDraftSection>
      </>
    );
  };

  if (props.status !== 'pending') {
    const record = isCreate ? createRecord : updateRecord;
    return (
      <div className="ai-recipe-editor ai-confirmation-editor ai-meal-log-draft-editor">
        {renderResolvedSummary(record, isCreate ? 'create' : action)}
      </div>
    );
  }

  return (
    <div className="ai-recipe-editor ai-confirmation-editor ai-meal-log-draft-editor">
      {isCreate
        ? renderCreateEditor()
        : action === 'update_details'
          ? renderUpdateDetailsEditor()
          : action === 'rate_food'
            ? renderRatingEditor()
            : renderPendingSummary(updateRecord, action)}
    </div>
  );
}
