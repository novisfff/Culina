import type { AiApprovalRequest } from '../../../../api/types';
import { buildUnitPresetOptions, INVENTORY_STORAGE_PRESETS } from '../../../ingredients/ingredientWorkspaceForms';
import { getIngredientEditorCategoryPresets } from '../../../ingredients/workspaceModel';
import {
  ApprovalComboboxField,
  ApprovalSelectField,
} from '../../AiApprovalFields';
import { asDraftArray, asNumber, asText } from '../../aiDraftValueUtils';
import { AiDraftImpactNote } from '../AiDraftImpactNote';
import { AiDraftItemCard } from '../AiDraftItemCard';
import { AiDraftResolvedSummary } from '../AiDraftResolvedSummary';
import { AiDraftSection } from '../AiDraftSection';
import { AiDraftSummaryCard } from '../AiDraftSummaryCard';

const INGREDIENT_CATEGORY_OPTIONS = getIngredientEditorCategoryPresets().map((item) => ({
  value: item.label,
  label: item.label,
  description: [item.defaultStorage, item.defaultUnit ? `默认 ${item.defaultUnit}` : ''].filter(Boolean).join(' · '),
}));

const STORAGE_OPTIONS = INVENTORY_STORAGE_PRESETS.map((storage) => ({
  value: storage,
  label: storage,
}));

const EXPIRY_MODE_OPTIONS = [
  { value: 'days', label: '按天数' },
  { value: 'manual_date', label: '手动日期' },
  { value: 'none', label: '不设置' },
];

type DraftRecord = Record<string, unknown>;

function recordFrom(value: unknown): DraftRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as DraftRecord
    : {};
}

function expiryModeLabel(value: unknown) {
  switch (asText(value, 'none')) {
    case 'days':
      return '按天数';
    case 'manual_date':
      return '入库时手动日期';
    case 'none':
      return '不设置';
    default:
      return asText(value) || '不设置';
  }
}

function expirySummary(payload: DraftRecord) {
  const mode = asText(payload.default_expiry_mode, 'none');
  if (mode === 'days') {
    const days = asNumber(payload.default_expiry_days, 0);
    return days > 0 ? `${days} 天` : '按天数，待补天数';
  }
  return expiryModeLabel(mode);
}

function lowStockSummary(payload: DraftRecord) {
  const threshold = payload.default_low_stock_threshold;
  if (threshold === null || threshold === undefined || threshold === '') return '不设置';
  const unit = asText(payload.default_unit);
  return `${String(threshold)}${unit ? ` ${unit}` : ''}`;
}

function conversionSummary(value: unknown, defaultUnit: string) {
  const conversions = asDraftArray(value);
  if (conversions.length === 0) return '未设置副单位';
  return conversions.map((item) => {
    const unit = asText(item.unit);
    const ratio = item.ratio_to_default;
    const ratioText = typeof ratio === 'number' && Number.isFinite(ratio) ? String(ratio) : asText(ratio);
    return `${unit || '副单位'} = ${ratioText || '?'}${defaultUnit ? ` ${defaultUnit}` : ''}`;
  }).join('、');
}

function actionLabel(action: string) {
  return action === 'update' ? '修改' : '新增';
}

function resolvedTitle(status: AiApprovalRequest['status'], action: string) {
  if (status === 'approved') return `${action === 'update' ? '已更新' : '已创建'}食材档案`;
  if (status === 'rejected') return '未写入的食材草稿';
  return '已过期的食材草稿';
}

function resolvedStatus(status: string): 'approved' | 'rejected' | 'expired' | 'cancelled' | 'canceled' {
  if (status === 'approved' || status === 'rejected' || status === 'expired' || status === 'cancelled' || status === 'canceled') {
    return status;
  }
  return 'expired';
}

function profileSummaryItems(payload: DraftRecord, before: DraftRecord) {
  const defaultUnit = asText(payload.default_unit);
  return [
    { label: '食材名称', value: asText(payload.name) || asText(before.name) || '未命名食材' },
    { label: '分类', value: asText(payload.category) || asText(before.category) || '未填写' },
    { label: '默认单位', value: defaultUnit || asText(before.default_unit) || '未填写' },
    { label: '默认保存', value: asText(payload.default_storage) || asText(before.default_storage) || '未填写' },
    { label: '保质期', value: expirySummary(payload) },
    { label: '低库存提醒', value: lowStockSummary(payload) },
    { label: '单位换算', value: conversionSummary(payload.unit_conversions, defaultUnit) },
  ];
}

function IngredientProfileFields(props: {
  payload: DraftRecord;
  readonly: boolean;
  onPayloadChange: (patch: DraftRecord) => void;
}) {
  const defaultUnit = asText(props.payload.default_unit);
  const expiryMode = asText(props.payload.default_expiry_mode, 'none');
  const unitConversions = asDraftArray(props.payload.unit_conversions);
  const defaultUnitOptions = buildUnitPresetOptions(defaultUnit).map((unit) => ({ value: unit, label: unit }));

  const updateUnitConversion = (index: number, patch: DraftRecord) => {
    props.onPayloadChange({
      unit_conversions: unitConversions.map((item, itemIndex) => (
        itemIndex === index ? { ...item, ...patch } : item
      )),
    });
  };

  const removeUnitConversion = (index: number) => {
    props.onPayloadChange({
      unit_conversions: unitConversions.filter((_, itemIndex) => itemIndex !== index),
    });
  };

  const addUnitConversion = () => {
    props.onPayloadChange({
      unit_conversions: [...unitConversions, { unit: '', ratio_to_default: 1 }],
    });
  };

  return (
    <>
      <AiDraftSection
        title="核心信息"
        description="用于食材库检索和后续菜谱、库存匹配。"
        className="ai-confirmation-item ai-ingredient-profile-section"
      >
        <div className="ai-confirmation-grid">
          <label className="ai-resource-field">
            <span>食材名称</span>
            <input
              className="text-input"
              value={asText(props.payload.name)}
              disabled={props.readonly}
              onChange={(event) => props.onPayloadChange({ name: event.target.value })}
            />
          </label>
          <ApprovalComboboxField
            label="分类"
            value={asText(props.payload.category)}
            disabled={props.readonly}
            options={INGREDIENT_CATEGORY_OPTIONS}
            placeholder="选择分类或自定义"
            icon="type"
            onChange={(category) => props.onPayloadChange({ category })}
          />
          <ApprovalComboboxField
            label="默认单位"
            value={defaultUnit}
            disabled={props.readonly}
            options={defaultUnitOptions}
            placeholder="选择单位或自定义"
            icon="step"
            onChange={(nextUnit) => props.onPayloadChange({ default_unit: nextUnit })}
          />
        </div>
      </AiDraftSection>
      <AiDraftSection
        title="库存与追踪"
        description="保存与提醒作为新增库存时的默认建议，入库时仍可单独调整。"
        className="ai-confirmation-item ai-ingredient-profile-section"
      >
        <div className="ai-confirmation-grid ai-confirmation-grid-three">
          <ApprovalComboboxField
            label="默认保存"
            value={asText(props.payload.default_storage)}
            disabled={props.readonly}
            options={STORAGE_OPTIONS}
            placeholder="选择保存位置"
            icon="type"
            onChange={(defaultStorage) => props.onPayloadChange({ default_storage: defaultStorage })}
          />
          <ApprovalSelectField
            label="保质期模式"
            value={expiryMode}
            disabled={props.readonly}
            options={EXPIRY_MODE_OPTIONS}
            icon="calendar"
            onChange={(defaultExpiryMode) => props.onPayloadChange({
              default_expiry_mode: defaultExpiryMode,
              default_expiry_days: defaultExpiryMode === 'days' ? props.payload.default_expiry_days ?? 1 : null,
            })}
          />
          {expiryMode === 'days' ? (
            <label className="ai-resource-field">
              <span>默认保质期天数</span>
              <input
                className="text-input"
                type="number"
                min={1}
                step={1}
                value={props.payload.default_expiry_days == null ? '' : String(props.payload.default_expiry_days)}
                disabled={props.readonly}
                placeholder="例如 7"
                onChange={(event) => props.onPayloadChange({
                  default_expiry_days: event.target.value ? Number(event.target.value) : null,
                })}
              />
            </label>
          ) : (
            <div className="ai-resource-field ai-ingredient-profile-field-note">
              <span>默认保质期天数</span>
              <strong>{expiryMode === 'manual_date' ? '入库时手动选择日期' : '不设置默认保质期'}</strong>
            </div>
          )}
        </div>
        <label className="ai-resource-field ai-ingredient-profile-low-stock">
          <span>低库存阈值</span>
          <div className="ai-inline-unit-input">
            <input
              className="text-input"
              type="number"
              min={0.1}
              step="0.1"
              value={props.payload.default_low_stock_threshold == null ? '' : String(props.payload.default_low_stock_threshold)}
              disabled={props.readonly}
              placeholder="留空则不提醒"
              onChange={(event) => props.onPayloadChange({
                default_low_stock_threshold: event.target.value ? Number(event.target.value) : null,
              })}
            />
            {defaultUnit ? <span>{defaultUnit}</span> : null}
          </div>
          <small>当可用库存低于这个数量时提醒；不需要提醒可以留空。</small>
        </label>
      </AiDraftSection>
      <AiDraftSection
        title="高级设置"
        description="副单位用于以后入库换算，含义不确定时建议先留空。"
        className="ai-confirmation-item ai-ingredient-profile-section"
      >
        <div className="ai-ingredient-profile-conversion-list">
          {unitConversions.length > 0 ? unitConversions.map((item, index) => (
            <AiDraftItemCard
              key={index}
              title={asText(item.unit) || `副单位 ${index + 1}`}
              summary={`${asText(item.unit) || '副单位'} = ${item.ratio_to_default == null ? '?' : String(item.ratio_to_default)}${defaultUnit ? ` ${defaultUnit}` : ''}`}
              status="单位换算"
              className="ai-ingredient-profile-conversion-row"
              footer={!props.readonly ? (
                <button
                  className="ghost-button ai-ingredient-profile-remove-conversion"
                  type="button"
                  onClick={() => removeUnitConversion(index)}
                >
                  删除
                </button>
              ) : undefined}
            >
              <div className="ai-ingredient-profile-conversion-fields">
                <ApprovalComboboxField
                  label="副单位"
                  value={asText(item.unit)}
                  disabled={props.readonly}
                  options={buildUnitPresetOptions(asText(item.unit)).map((unit) => ({ value: unit, label: unit }))}
                  placeholder="选择副单位"
                  icon="step"
                  onChange={(unit) => updateUnitConversion(index, { unit })}
                />
                <label className="ai-resource-field">
                  <span>等于多少默认单位</span>
                  <div className="ai-inline-unit-input">
                    <input
                      className="text-input"
                      type="number"
                      min={0.1}
                      step="0.1"
                      value={item.ratio_to_default == null ? '' : String(item.ratio_to_default)}
                      disabled={props.readonly}
                      placeholder="例如 500"
                      onChange={(event) => updateUnitConversion(index, {
                        ratio_to_default: event.target.value ? Number(event.target.value) : null,
                      })}
                    />
                    {defaultUnit ? <span>{defaultUnit}</span> : null}
                  </div>
                </label>
              </div>
            </AiDraftItemCard>
          )) : (
            <p className="ai-ingredient-profile-empty-conversion">暂不设置副单位。</p>
          )}
          {!props.readonly ? (
            <button className="ghost-button ai-ingredient-profile-add-conversion" type="button" onClick={addUnitConversion}>
              添加副单位
            </button>
          ) : null}
        </div>
        <label className="ai-resource-field ai-confirmation-copy-field">
          <span>备注</span>
          <textarea
            className="text-input"
            rows={3}
            value={asText(props.payload.notes)}
            disabled={props.readonly}
            placeholder="补充采购、保存或使用习惯"
            onChange={(event) => props.onPayloadChange({ notes: event.target.value })}
          />
        </label>
      </AiDraftSection>
    </>
  );
}

function AiIngredientProfileBatchDraftView(props: {
  draft: DraftRecord;
  operations: DraftRecord[];
  readonly: boolean;
  status: AiApprovalRequest['status'];
  onDraftChange: (next: DraftRecord) => void;
}) {
  const names = props.operations.map((operation) => asText(recordFrom(operation.payload).name)).filter(Boolean);
  const batchItems = [
    { label: '食材档案', value: `${props.operations.length} 项` },
    { label: '待创建', value: names.join('、') || '食材档案' },
  ];
  const updatePayload = (index: number, patch: DraftRecord) => {
    props.onDraftChange({
      ...props.draft,
      operations: props.operations.map((operation, operationIndex) => (
        operationIndex === index
          ? { ...operation, payload: { ...recordFrom(operation.payload), ...patch } }
          : operation
      )),
    });
  };

  if (props.status !== 'pending') {
    const title = props.status === 'approved'
      ? `已创建 ${props.operations.length} 个食材档案`
      : props.status === 'rejected'
        ? '未写入的批量食材草稿'
        : '已过期的批量食材草稿';
    return (
      <div className="ai-recipe-editor ai-confirmation-editor ai-ingredient-profile-draft-editor">
        <AiDraftResolvedSummary
          status={resolvedStatus(props.status)}
          title={title}
          summary={names.join('、') || '食材档案'}
          className="ai-ingredient-profile-summary-card"
        >
          <dl className="ai-draft-summary-items">
            {batchItems.map((item) => (
              <div key={item.label} className="ai-draft-summary-item">
                <dt>{item.label}</dt>
                <dd>{item.value}</dd>
              </div>
            ))}
          </dl>
        </AiDraftResolvedSummary>
      </div>
    );
  }

  return (
    <div className="ai-recipe-editor ai-confirmation-editor ai-ingredient-profile-draft-editor">
      <div className="ai-draft-editor-head">
        <div>
          <strong>批量创建食材档案</strong>
          <span>一次确认创建 {props.operations.length} 个食材，不会登记库存数量。</span>
        </div>
      </div>
      <AiDraftSummaryCard
        title="待确认批量食材档案"
        items={batchItems}
        className="ai-confirmation-item ai-ingredient-profile-summary-card"
      >
        <AiDraftImpactNote tone="plan" title="确认后">
          <p>会一次创建 {props.operations.length} 个食材档案，不会登记库存数量。</p>
        </AiDraftImpactNote>
      </AiDraftSummaryCard>
      {props.operations.map((operation, index) => {
        const payload = recordFrom(operation.payload);
        return (
          <AiDraftItemCard
            key={asText(operation.operationId) || String(index)}
            title={`食材 ${index + 1}`}
            summary={asText(payload.name) || '待填写名称'}
            status="待创建"
            className="ai-confirmation-item ai-ingredient-profile-batch-item"
          >
            <IngredientProfileFields
              payload={payload}
              readonly={props.readonly}
              onPayloadChange={(patch) => updatePayload(index, patch)}
            />
          </AiDraftItemCard>
        );
      })}
    </div>
  );
}

export function AiIngredientProfileDraftView(props: {
  draft: DraftRecord;
  readonly: boolean;
  status: AiApprovalRequest['status'];
  onDraftChange: (next: DraftRecord) => void;
}) {
  const action = asText(props.draft.action, 'create');
  const operations = asDraftArray(props.draft.operations);

  if (operations.length > 0) {
    return (
      <AiIngredientProfileBatchDraftView
        draft={props.draft}
        operations={operations}
        readonly={props.readonly}
        status={props.status}
        onDraftChange={props.onDraftChange}
      />
    );
  }

  const payload = props.draft.payload && typeof props.draft.payload === 'object' && !Array.isArray(props.draft.payload)
    ? props.draft.payload as DraftRecord
    : props.draft;
  const before = recordFrom(props.draft.before);
  const items = profileSummaryItems(payload, before);
  const updatePayload = (patch: DraftRecord) => {
    props.onDraftChange({ ...props.draft, payload: { ...payload, ...patch } });
  };
  const confirmationCopy = action === 'update'
    ? '只更新食材档案默认值，不直接修改已有库存批次。'
    : '确认后会创建新的家庭食材档案，不会登记库存数量。';

  if (props.status !== 'pending') {
    return (
      <div className="ai-recipe-editor ai-confirmation-editor ai-ingredient-profile-draft-editor">
        <AiDraftResolvedSummary
          status={resolvedStatus(props.status)}
          title={resolvedTitle(props.status, action)}
          summary={asText(payload.name) || asText(before.name) || '食材档案'}
          className="ai-ingredient-profile-summary-card"
        >
          <dl className="ai-draft-summary-items">
            {items.map((item) => (
              <div key={item.label} className="ai-draft-summary-item">
                <dt>{item.label}</dt>
                <dd>{item.value}</dd>
              </div>
            ))}
          </dl>
          {asText(payload.notes) ? <p className="ai-ingredient-profile-summary-note">{asText(payload.notes)}</p> : null}
        </AiDraftResolvedSummary>
      </div>
    );
  }

  return (
    <div className="ai-recipe-editor ai-confirmation-editor ai-ingredient-profile-draft-editor">
      <div className="ai-draft-editor-head">
        <div>
          <strong>{actionLabel(action)}食材档案</strong>
          <span>{asText(payload.name) || asText(before.name) || '食材档案'}</span>
        </div>
      </div>
      <AiDraftSummaryCard
        title={`待确认${actionLabel(action)}食材档案`}
        items={items}
        className="ai-confirmation-item ai-ingredient-profile-summary-card"
      >
        <AiDraftImpactNote tone="plan" title="确认后">
          <p>{confirmationCopy}</p>
        </AiDraftImpactNote>
        {asText(payload.notes) ? <p className="ai-ingredient-profile-summary-note">{asText(payload.notes)}</p> : null}
      </AiDraftSummaryCard>
      {action === 'update' ? (
        <AiDraftImpactNote tone="plan" title="当前与调整后" className="ai-ingredient-profile-before-after">
          <p>当前：{[asText(before.name), asText(before.category), asText(before.default_unit), asText(before.default_storage)].filter(Boolean).join(' · ') || '未记录'}</p>
          <p>调整后：{[asText(payload.name), asText(payload.category), asText(payload.default_unit), asText(payload.default_storage)].filter(Boolean).join(' · ') || '待填写'}</p>
          <p>只更新食材档案默认值，不直接修改已有库存批次。</p>
        </AiDraftImpactNote>
      ) : null}
      <IngredientProfileFields payload={payload} readonly={props.readonly} onPayloadChange={updatePayload} />
    </div>
  );
}
