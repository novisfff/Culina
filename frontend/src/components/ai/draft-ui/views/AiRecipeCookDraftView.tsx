import type { AiApprovalRequest } from '../../../../api/types';
import { ApprovalSelectField, ResourceSelectIcon } from '../../AiApprovalFields';
import { asDraftArray, asNumber, asText, draftNumberInputValue } from '../../aiDraftValueUtils';
import { AiDraftImpactNote } from '../AiDraftImpactNote';
import { AiDraftItemCard } from '../AiDraftItemCard';
import { AiDraftResolvedSummary } from '../AiDraftResolvedSummary';
import { AiDraftSection } from '../AiDraftSection';
import { AiDraftSummaryCard } from '../AiDraftSummaryCard';

type RecipeCookSchemaVersion = 'recipe_cook_operation.v1' | 'recipe_cook_operation.v2' | 'unknown';

const MEAL_TYPE_OPTIONS = [
  { value: 'breakfast', label: '早餐' },
  { value: 'lunch', label: '午餐' },
  { value: 'dinner', label: '晚餐' },
  { value: 'snack', label: '加餐' },
];

function recordFrom(value: unknown) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function mealTypeLabel(value: unknown) {
  const normalized = asText(value).replace(/^MealType\./i, '').toLowerCase();
  return MEAL_TYPE_OPTIONS.find((option) => option.value === normalized)?.label ?? asText(value);
}

function mealPlanStatusLabel(value: unknown) {
  switch (asText(value, 'planned')) {
    case 'planned':
      return '计划中';
    case 'cooked':
      return '已完成';
    case 'skipped':
      return '已跳过';
    default:
      return asText(value);
  }
}

function formatServingCount(value: unknown) {
  const numeric = asNumber(value, 0);
  return Number.isInteger(numeric) ? String(numeric) : String(Number(numeric.toFixed(1)));
}

function formatDraftQuantity(quantity: unknown, unit: unknown) {
  const numeric = asNumber(quantity, 0);
  const display = Number.isInteger(numeric) ? String(numeric) : String(Number(numeric.toFixed(2)));
  return `${display}${asText(unit) ? ` ${asText(unit)}` : ''}`;
}

function linkedPlanItemFromDraft(draft: Record<string, unknown>) {
  const before = recordFrom(draft.before);
  const linkedPlanItem = before.linkedPlanItem;
  return typeof linkedPlanItem === 'object' && linkedPlanItem !== null && !Array.isArray(linkedPlanItem)
    ? linkedPlanItem as Record<string, unknown>
    : undefined;
}

function recipeCookLinkedPlanSummary(value: Record<string, unknown> | undefined) {
  if (!value) return '未关联计划';
  const date = asText(value.plan_date) || asText(value.date);
  const meal = mealTypeLabel(value.meal_type ?? value.mealType);
  const food = asText(value.food_name) || asText(value.title) || asText(value.name);
  const status = asText(value.status) ? mealPlanStatusLabel(value.status) : '';
  return [date, meal, food, status].filter(Boolean).join(' · ') || '已关联计划';
}

function recipeCookMealLogSummary(schemaVersion: RecipeCookSchemaVersion) {
  return schemaVersion === 'recipe_cook_operation.v2' ? '完成后会记录这餐' : '旧草稿需要刷新后重新确认';
}

function recipeCookSummaryItems(
  draft: Record<string, unknown>,
  previewItems: Record<string, unknown>[],
  shortages: Record<string, unknown>[],
  linkedPlanItem: Record<string, unknown> | undefined,
  schemaVersion: RecipeCookSchemaVersion,
) {
  const mealType = asText(draft.mealType, 'dinner');
  return [
    { label: '菜谱', value: asText(draft.title) || '菜谱' },
    { label: '日期', value: asText(draft.date) || '未设置' },
    { label: '餐别', value: MEAL_TYPE_OPTIONS.find((option) => option.value === mealType)?.label || mealType },
    { label: '份数', value: `${formatServingCount(draft.servings)} 份` },
    { label: '库存扣减', value: previewItems.length > 0 ? `${previewItems.length} 种食材` : '无扣减项' },
    { label: '餐食记录', value: recipeCookMealLogSummary(schemaVersion) },
    { label: '关联计划', value: recipeCookLinkedPlanSummary(linkedPlanItem) },
    { label: '缺料', value: shortages.length > 0 ? `${shortages.length} 项需补齐` : '库存充足' },
  ];
}

function resolvedTitle(status: string) {
  if (status === 'approved') return '做菜执行已确认';
  if (status === 'rejected') return '未执行的做菜草稿';
  if (status === 'expired') return '已过期的做菜草稿';
  return '已处理的做菜草稿';
}

function resolvedStatus(status: string): 'approved' | 'rejected' | 'expired' | 'cancelled' | 'canceled' {
  if (status === 'approved' || status === 'rejected' || status === 'expired' || status === 'cancelled' || status === 'canceled') {
    return status;
  }
  return 'expired';
}

export function AiRecipeCookDraftView(props: {
  draft: Record<string, unknown>;
  readonly: boolean;
  status: AiApprovalRequest['status'];
  schemaVersion: RecipeCookSchemaVersion;
  requiresRegeneration: boolean;
  onDraftChange: (next: Record<string, unknown>) => void;
}) {
  const previewItems = asDraftArray(props.draft.previewItems);
  const shortages = asDraftArray(props.draft.shortages);
  const linkedPlanItem = linkedPlanItemFromDraft(props.draft);
  const summaryItems = recipeCookSummaryItems(props.draft, previewItems, shortages, linkedPlanItem, props.schemaVersion);
  const mealLogCopy = recipeCookMealLogSummary(props.schemaVersion);
  const executionCopy = props.schemaVersion === 'recipe_cook_operation.v2'
    ? '确认后会按预览扣减库存，并同时写入餐食记录。'
    : '这份旧草稿需要刷新后重新确认；当前不会执行扣库存或写入餐食记录。';
  const updateDraft = (patch: Record<string, unknown>) => props.onDraftChange({ ...props.draft, ...patch });

  if (props.status !== 'pending') {
    return (
      <div className="ai-recipe-editor ai-confirmation-editor ai-recipe-cook-draft-editor">
        <AiDraftResolvedSummary
          status={resolvedStatus(props.status)}
          title={resolvedTitle(props.status)}
          summary={asText(props.draft.title) || '菜谱'}
          className="ai-recipe-cook-summary-card"
        >
          <dl className="ai-draft-summary-items">
            {summaryItems.map((item) => (
              <div key={item.label} className="ai-draft-summary-item">
                <dt>{item.label}</dt>
                <dd>{item.value}</dd>
              </div>
            ))}
          </dl>
          {asText(props.draft.resultNote) ? <p className="ai-recipe-summary-note">{asText(props.draft.resultNote)}</p> : null}
        </AiDraftResolvedSummary>
      </div>
    );
  }

  return (
    <div className="ai-recipe-editor ai-confirmation-editor ai-recipe-cook-draft-editor">
      <div className="ai-draft-editor-head">
        <div>
          <strong>做菜执行</strong>
          <span>{asText(props.draft.title) || '菜谱'}</span>
        </div>
      </div>
      <AiDraftSummaryCard
        title={asText(props.draft.title) || '待确认做菜'}
        items={summaryItems}
        tone={props.requiresRegeneration ? 'danger' : shortages.length > 0 ? 'warning' : 'plan'}
        className="ai-confirmation-item ai-recipe-cook-summary-card"
      >
        <AiDraftImpactNote tone="plan" title="确认后">
          {executionCopy}
        </AiDraftImpactNote>
      </AiDraftSummaryCard>
      {props.requiresRegeneration ? (
        <AiDraftImpactNote tone="danger" title="需要刷新后重新确认">
          仅支持始终记录餐食的 v2 做菜草稿。请刷新会话并重新生成草稿后再确认。
        </AiDraftImpactNote>
      ) : null}

      <AiDraftSection
        title="做菜结果"
        description="确认本次做菜设置，并补充将要写入餐食记录的结果。"
        className="ai-confirmation-item"
      >
        <div className="ai-recipe-draft-section">
          <div className="ai-recipe-draft-section-head">
            <strong>执行设置</strong>
            <span>确认本次做菜份数、日期、餐别和关联计划。</span>
          </div>
          <div className="ai-confirmation-grid">
            <label className="ai-resource-field">
              <span>份数</span>
              <input className="text-input" type="number" min={0.1} step={0.1} value={draftNumberInputValue(props.draft.servings, 1)} disabled />
              <small>份数会改变库存扣减预览，如需调整请重新生成草稿</small>
            </label>
            <label className="ai-resource-field ai-resource-field-date">
              <span>日期</span>
              <div className="ai-resource-select">
                <ResourceSelectIcon kind="calendar" />
                <input
                  type="date"
                  value={asText(props.draft.date)}
                  disabled={props.readonly || props.requiresRegeneration}
                  onChange={(event) => updateDraft({ date: event.target.value })}
                />
              </div>
            </label>
            <ApprovalSelectField
              label="餐别"
              value={asText(props.draft.mealType, 'dinner')}
              disabled={props.readonly || props.requiresRegeneration}
              options={MEAL_TYPE_OPTIONS}
              icon="meal"
              onChange={(mealType) => updateDraft({ mealType })}
            />
            <div className="ai-resource-field">
              <span>餐食记录</span>
              <p className="ai-recipe-summary-note">{mealLogCopy}</p>
            </div>
          </div>
          <AiDraftImpactNote tone="neutral" title="关联计划">
            <p>关联计划：{recipeCookLinkedPlanSummary(linkedPlanItem)}</p>
          </AiDraftImpactNote>
        </div>
        <div className="ai-recipe-draft-section">
          <div className="ai-recipe-draft-section-head">
            <strong>餐食记录补充</strong>
            <span>
              {props.schemaVersion === 'recipe_cook_operation.v2'
                ? '完成后会自动写入餐食记录；这里补充备注与结果说明。'
                : '这份旧草稿需要刷新后重新确认，当前不会写入餐食记录。'}
            </span>
          </div>
          <label className="ai-resource-field ai-confirmation-copy-field">
            <span>餐食备注</span>
            <textarea className="text-input" rows={2} value={asText(props.draft.notes)} disabled={props.readonly || props.requiresRegeneration} placeholder="生成餐食记录时附带说明" onChange={(event) => updateDraft({ notes: event.target.value })} />
          </label>
          <label className="ai-resource-field ai-confirmation-copy-field">
            <span>结果备注</span>
            <textarea className="text-input" rows={2} value={asText(props.draft.resultNote)} disabled={props.readonly || props.requiresRegeneration} placeholder="记录成品效果、口味等" onChange={(event) => updateDraft({ resultNote: event.target.value })} />
          </label>
          <label className="ai-resource-field ai-confirmation-copy-field">
            <span>调整说明</span>
            <textarea className="text-input" rows={2} value={asText(props.draft.adjustments)} disabled={props.readonly || props.requiresRegeneration} placeholder="记录替换食材或临时调整" onChange={(event) => updateDraft({ adjustments: event.target.value })} />
          </label>
        </div>
      </AiDraftSection>

      <AiDraftSection
        title="食材与库存"
        description="按食材核对库存扣减预览与缺料阻断。"
        className="ai-confirmation-item"
      >
        <div className="ai-recipe-draft-section">
          <div className="ai-recipe-draft-section-head ai-recipe-draft-section-head-row">
            <div>
              <strong>库存扣减预览</strong>
              <span>按食材核对请求数量和实际扣减批次。</span>
            </div>
            <span>{previewItems.length} 项</span>
          </div>
          {previewItems.length > 0 ? previewItems.map((item, index) => {
            const batches = asDraftArray(item.batches);
            return (
              <AiDraftItemCard
                key={`${asText(item.ingredient_name)}-${index}`}
                title={asText(item.ingredient_name) || `食材 ${index + 1}`}
                summary={`需要 ${formatDraftQuantity(item.requested_quantity, item.unit)}`}
                className="ai-recipe-cook-preview-card"
              >
                <div className="ai-recipe-cook-batch-list">
                  {batches.length > 0 ? batches.map((batch, batchIndex) => (
                    <p className="ai-recipe-cook-batch-copy" key={`${asText(batch.inventory_item_id)}-${batchIndex}`}>
                      批次 {batchIndex + 1}：扣 {formatDraftQuantity(batch.quantity, batch.unit)}
                      {asText(batch.storage_location) ? ` · ${asText(batch.storage_location)}` : ''}
                      {asText(batch.purchase_date) ? ` · 购于 ${asText(batch.purchase_date)}` : ''}
                      {asText(batch.expiry_date) ? ` · 到期 ${asText(batch.expiry_date)}` : ''}
                    </p>
                  )) : (
                    <p className="ai-recipe-summary-note">没有具体批次明细，确认前建议重新预览库存。</p>
                  )}
                </div>
              </AiDraftItemCard>
            );
          }) : (
            <p className="ai-recipe-summary-note">没有库存扣减项，确认前建议检查菜谱食材或重新生成草稿。</p>
          )}
        </div>
        <div className="ai-recipe-draft-section">
          <div className="ai-recipe-draft-section-head ai-recipe-draft-section-head-row">
            <div>
              <strong>缺料与阻断</strong>
              <span>有缺料时不能直接执行做菜扣库存。</span>
            </div>
            <span>{shortages.length > 0 ? `${shortages.length} 项` : '库存充足'}</span>
          </div>
          {shortages.length > 0 ? (
            <AiDraftImpactNote tone="warning" title="库存提醒">
              当前草稿不能确认执行。请先补齐库存或调整份数后重新生成做菜草稿；确认按钮会被前端阻断。
            </AiDraftImpactNote>
          ) : (
            <p className="ai-recipe-summary-note">预览没有发现缺料，可以按上方批次扣减库存。</p>
          )}
          {shortages.map((item, index) => (
            <AiDraftItemCard
              key={`${asText(item.ingredient_name)}-${index}`}
              title={asText(item.ingredient_name) || `缺料 ${index + 1}`}
              summary={`缺 ${formatDraftQuantity(item.missing_quantity, item.unit)} · 现有 ${formatDraftQuantity(item.available_quantity, item.unit)} · 需要 ${formatDraftQuantity(item.required_quantity, item.unit)}`}
              className="ai-recipe-cook-shortage-card"
            >
              <span>请补齐库存或重新生成草稿。</span>
            </AiDraftItemCard>
          ))}
        </div>
      </AiDraftSection>
    </div>
  );
}
