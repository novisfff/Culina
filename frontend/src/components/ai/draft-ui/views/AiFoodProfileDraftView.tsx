import type { AiApprovalRequest } from '../../../../api/types';
import { INVENTORY_STORAGE_PRESETS } from '../../../ingredients/ingredientWorkspaceForms';
import {
  ApprovalComboboxField,
  ApprovalMultiSelectField,
  ApprovalSelectField,
} from '../../AiApprovalFields';
import { asText, draftNumberInputValue } from '../../aiDraftValueUtils';
import { formatFoodStockAmount } from '../../../../lib/foodStockQuantity';
import { AiDraftImpactNote } from '../AiDraftImpactNote';
import { AiDraftItemCard } from '../AiDraftItemCard';
import { AiDraftResolvedSummary } from '../AiDraftResolvedSummary';
import { AiDraftSection } from '../AiDraftSection';
import { AiDraftSummaryCard } from '../AiDraftSummaryCard';
import { AiDraftTagInput, normalizeAiDraftTagValues } from '../AiDraftTagInput';

const MEAL_TYPE_OPTIONS = [
  { value: 'breakfast', label: '早餐' },
  { value: 'lunch', label: '午餐' },
  { value: 'dinner', label: '晚餐' },
  { value: 'snack', label: '加餐' },
];

const FOOD_TYPE_OPTIONS = [
  { value: 'selfMade', label: '家常菜' },
  { value: 'takeout', label: '外卖' },
  { value: 'diningOut', label: '外食' },
  { value: 'readyMade', label: '成品' },
  { value: 'instant', label: '速食' },
  { value: 'packaged', label: '包装食品' },
];

const FOOD_FLAVOR_PRESETS = ['清淡', '酸甜', '香辣', '咸鲜', '奶香', '酥脆', '软糯', '孩子喜欢'];

const STORAGE_OPTIONS = INVENTORY_STORAGE_PRESETS.map((storage) => ({
  value: storage,
  label: storage,
}));

function recordFrom(value: unknown) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function foodTypeText(value: string) {
  switch (value) {
    case 'readyMade':
      return '现成食物';
    case 'selfMade':
      return '自制食物';
    case 'instant':
      return '速食';
    case 'packaged':
      return '包装食品';
    case 'takeout':
      return '外卖';
    case 'diningOut':
      return '外食';
    default:
      return value;
  }
}

function mealTypeLabel(value: string) {
  const normalized = value.replace(/^MealType\./i, '').toLowerCase();
  return MEAL_TYPE_OPTIONS.find((option) => option.value === normalized)?.label ?? value;
}

function profileRecord(value: Record<string, unknown>, fallback: Record<string, unknown> = {}) {
  const type = asText(value.type) || asText(fallback.type) || 'readyMade';
  return {
    ...fallback,
    ...value,
    name: asText(value.name) || asText(fallback.name),
    type,
    category: asText(value.category) || asText(fallback.category),
    suitableMealTypes: normalizeAiDraftTagValues(
      value.suitable_meal_types ?? value.suitableMealTypes ?? fallback.suitable_meal_types ?? fallback.suitableMealTypes,
    ),
    flavorTags: normalizeAiDraftTagValues(
      value.flavor_tags ?? value.flavorTags ?? fallback.flavor_tags ?? fallback.flavorTags,
    ),
    sourceName: asText(value.source_name) || asText(value.sourceName) || asText(fallback.source_name) || asText(fallback.sourceName),
    notes: asText(value.notes) || asText(fallback.notes),
    stockQuantity: value.stock_quantity ?? value.stockQuantity ?? fallback.stock_quantity ?? fallback.stockQuantity ?? null,
    stockUnit: asText(value.stock_unit) || asText(value.stockUnit) || asText(fallback.stock_unit) || asText(fallback.stockUnit),
    storageLocation: asText(value.storage_location) || asText(value.storageLocation) || asText(fallback.storage_location) || asText(fallback.storageLocation),
    favorite: Boolean(value.favorite ?? fallback.favorite),
  };
}

function isReadyLikeFoodProfileType(value: string) {
  return value === 'readyMade' || value === 'instant' || value === 'packaged';
}

function stockLabel(record: ReturnType<typeof profileRecord>) {
  const quantity = draftNumberInputValue(record.stockQuantity, '');
  return typeof quantity === 'number' ? formatFoodStockAmount(quantity, record.stockUnit || '份') : '未填写';
}

function summaryItems(record: ReturnType<typeof profileRecord>) {
  return [
    { label: '食物名', value: record.name || '未命名食物' },
    { label: '类型', value: FOOD_TYPE_OPTIONS.find((option) => option.value === record.type)?.label || foodTypeText(record.type) || '未设置' },
    { label: '分类', value: record.category || '未填写' },
    { label: '适合餐别', value: record.suitableMealTypes.map(mealTypeLabel).filter(Boolean).join('、') || '未设置' },
    { label: '口味标签', value: record.flavorTags.join('、') || '未设置' },
    { label: '来源', value: record.sourceName || '未填写' },
    ...(isReadyLikeFoodProfileType(record.type)
      ? [
          { label: '库存', value: stockLabel(record) },
          { label: '存放位置', value: record.storageLocation || '常温' },
        ]
      : []),
  ];
}

function actionLabel(action: string) {
  switch (action) {
    case 'create':
      return '新增';
    case 'update':
      return '修改';
    case 'set_favorite':
      return '收藏';
    default:
      return action || '创建';
  }
}

function statusTitle(status: AiApprovalRequest['status'], action: string) {
  const label = actionLabel(action);
  if (status === 'approved') return `${label}食物资料已确认`;
  if (status === 'rejected') return '未写入的食物资料草稿';
  if (status === 'expired') return '已过期的食物资料草稿';
  return `${label}食物资料`;
}

function resolvedStatus(status: string): 'approved' | 'rejected' | 'expired' | 'cancelled' | 'canceled' {
  if (status === 'approved' || status === 'rejected' || status === 'expired' || status === 'cancelled' || status === 'canceled') {
    return status;
  }
  return 'expired';
}

function favoriteLabel(value: unknown) {
  return Boolean(value) ? '已收藏' : '未收藏';
}

export function AiFoodProfileDraftView(props: {
  draft: Record<string, unknown>;
  readonly: boolean;
  status: AiApprovalRequest['status'];
  categoryOptions: Array<{ value: string; label: string; description?: string }>;
  onDraftChange: (next: Record<string, unknown>) => void;
}) {
  const action = asText(props.draft.action);
  const payload = action ? recordFrom(props.draft.payload) : props.draft;
  const before = recordFrom(props.draft.before);
  const record = profileRecord(payload, before);
  const currentAction = action || 'create';

  const updatePayload = (patch: Record<string, unknown>) => {
    if (action) {
      props.onDraftChange({ ...props.draft, payload: { ...payload, ...patch } });
      return;
    }
    props.onDraftChange({ ...props.draft, ...patch });
  };

  const renderSummaryDetails = () => (
    <>
      <dl className="ai-draft-summary-items">
        {summaryItems(record).map((item) => (
          <div key={item.label} className="ai-draft-summary-item">
            <dt>{item.label}</dt>
            <dd>{item.value}</dd>
          </div>
        ))}
      </dl>
      {record.notes ? <p className="ai-food-profile-summary-note">{record.notes}</p> : null}
    </>
  );

  const renderSummary = () => {
    const summary = action === 'set_favorite'
      ? '确认后只更新收藏状态，不修改食物资料内容。'
      : '确认后会写入食物资料，用于餐食记录、计划和推荐。';

    if (props.status !== 'pending') {
      return (
        <AiDraftResolvedSummary
          status={resolvedStatus(props.status)}
          title={statusTitle(props.status, currentAction)}
          summary={summary}
          className="ai-food-profile-summary-card"
        >
          {renderSummaryDetails()}
        </AiDraftResolvedSummary>
      );
    }

    return (
      <AiDraftSummaryCard
        title={statusTitle(props.status, currentAction)}
        items={summaryItems(record)}
        className="ai-confirmation-item ai-food-profile-summary-card"
      >
        <AiDraftImpactNote tone="plan" title="确认后">
          <p>{summary}</p>
        </AiDraftImpactNote>
        {record.notes ? <p className="ai-food-profile-summary-note">{record.notes}</p> : null}
      </AiDraftSummaryCard>
    );
  };

  const renderProfileForm = () => (
    <>
      <AiDraftSection
        title="核心信息"
        description="确认名称、类型和家庭分类，分类可选择已有值或自定义。"
        className="ai-confirmation-item ai-food-profile-section"
      >
        <label className="ai-resource-field">
          <span>食物名称</span>
          <input
            className="text-input"
            value={record.name}
            disabled={props.readonly}
            onChange={(event) => updatePayload({ name: event.target.value })}
          />
        </label>
        <div className="ai-confirmation-grid">
          <ApprovalSelectField
            label="类型"
            value={record.type}
            disabled={props.readonly}
            options={FOOD_TYPE_OPTIONS}
            icon="type"
            onChange={(type) => updatePayload({ type })}
          />
          <ApprovalComboboxField
            label="分类"
            value={record.category}
            disabled={props.readonly}
            options={props.categoryOptions}
            placeholder="选择或输入分类"
            icon="type"
            onChange={(category) => updatePayload({ category })}
          />
        </div>
      </AiDraftSection>
      <AiDraftSection
        title="适用场景"
        description="餐别是固定多选；口味标签会去重并过滤空值。"
        className="ai-confirmation-item ai-food-profile-section"
      >
        <ApprovalMultiSelectField
          label="适合餐别"
          values={record.suitableMealTypes}
          disabled={props.readonly}
          options={MEAL_TYPE_OPTIONS}
          onChange={(suitableMealTypes) => updatePayload({ suitable_meal_types: suitableMealTypes })}
        />
        <AiDraftTagInput
          label="口味标签"
          values={record.flavorTags}
          disabled={props.readonly}
          placeholder="清淡、酸甜、香辣"
          className="ai-resource-field ai-tag-input-field"
          onChange={(flavorTags) => updatePayload({ flavor_tags: flavorTags })}
        />
        <div className="ai-food-profile-tag-presets" aria-label="口味标签预设">
          {FOOD_FLAVOR_PRESETS.map((tag) => (
            <button
              key={tag}
              type="button"
              className={record.flavorTags.includes(tag) ? 'is-selected' : ''}
              disabled={props.readonly}
              onClick={() => updatePayload({
                flavor_tags: record.flavorTags.includes(tag)
                  ? record.flavorTags.filter((item) => item !== tag)
                  : [...record.flavorTags, tag],
              })}
            >
              {tag}
            </button>
          ))}
        </div>
      </AiDraftSection>
      <AiDraftSection
        title="来源与备注"
        description="来源属于开放信息，作为补充字段保留。"
        className="ai-confirmation-item ai-food-profile-section"
      >
        <label className="ai-resource-field">
          <span>来源</span>
          <input
            className="text-input"
            value={record.sourceName}
            disabled={props.readonly}
            placeholder="店铺、品牌或来源"
            onChange={(event) => updatePayload({ source_name: event.target.value })}
          />
        </label>
        <label className="ai-resource-field ai-confirmation-copy-field">
          <span>备注</span>
          <textarea
            className="text-input"
            rows={3}
            value={record.notes}
            disabled={props.readonly}
            placeholder="补充食用场景或偏好"
            onChange={(event) => updatePayload({ notes: event.target.value })}
          />
        </label>
        {isReadyLikeFoodProfileType(record.type) ? (
          <ApprovalSelectField
            label="存放位置"
            value={record.storageLocation || '常温'}
            disabled={props.readonly}
            options={STORAGE_OPTIONS}
            icon="type"
            onChange={(storageLocation) => updatePayload({ storage_location: storageLocation })}
          />
        ) : null}
      </AiDraftSection>
    </>
  );

  if (props.status !== 'pending') {
    return <div className="ai-recipe-editor ai-confirmation-editor ai-food-profile-draft-editor">{renderSummary()}</div>;
  }

  if (action === 'set_favorite') {
    return (
      <div className="ai-recipe-editor ai-confirmation-editor ai-food-profile-draft-editor">
        <div className="ai-draft-editor-head">
          <div>
            <strong>{actionLabel(currentAction)}食物资料</strong>
            <span>{record.name || '食物资料'}</span>
          </div>
        </div>
        {renderSummary()}
        <AiDraftItemCard
          title={record.name || asText(props.draft.targetId) || '食物资料'}
          summary={`当前：${favoriteLabel(before.favorite)} · 调整后：${favoriteLabel(payload.favorite)}`}
          status={actionLabel(currentAction)}
          className="ai-confirmation-item ai-food-profile-favorite-card"
        >
          <p>当前：{favoriteLabel(before.favorite)}</p>
          <p>调整后：{favoriteLabel(payload.favorite)}</p>
          <ApprovalSelectField
            label="收藏状态"
            value={String(Boolean(payload.favorite))}
            disabled={props.readonly}
            options={[
              { value: 'true', label: '加入收藏' },
              { value: 'false', label: '移出收藏' },
            ]}
            icon="type"
            onChange={(favorite) => updatePayload({ favorite: favorite === 'true' })}
          />
        </AiDraftItemCard>
      </div>
    );
  }

  return (
    <div className="ai-recipe-editor ai-confirmation-editor ai-food-profile-draft-editor">
      <div className="ai-draft-editor-head">
        <div>
          <strong>{action ? `${actionLabel(currentAction)}食物资料` : '食物资料'}</strong>
          <span>{action ? (record.name || '食物资料') : '确认名称、类型与适合餐别'}</span>
        </div>
      </div>
      {renderSummary()}
      {action === 'update' ? (
        <AiDraftImpactNote tone="plan" title="当前资料" className="ai-approval-compare-copy">
          <p>{[asText(before.name), foodTypeText(asText(before.type)), asText(before.category)].filter(Boolean).join(' · ') || '未记录'}</p>
        </AiDraftImpactNote>
      ) : null}
      {renderProfileForm()}
    </div>
  );
}
