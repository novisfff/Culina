import { asDraftArray, asNumber, asText } from './aiDraftValueUtils';
import { AiDraftImpactNote } from './draft-ui/AiDraftImpactNote';
import { AiDraftItemCard } from './draft-ui/AiDraftItemCard';
import { AiDraftResolvedSummary } from './draft-ui/AiDraftResolvedSummary';
import { AiDraftSection } from './draft-ui/AiDraftSection';
import { AiDraftSummaryCard } from './draft-ui/AiDraftSummaryCard';

export function getCompositeSteps(draft: Record<string, unknown>) {
  const fromPreview = Array.isArray(draft.stepPreviews)
    ? draft.stepPreviews
    : Array.isArray(draft.steps)
      ? draft.steps
      : [];
  return asDraftArray(fromPreview);
}

function compositeStepActionLabel(value: unknown) {
  switch (value) {
    case 'create':
      return '新增';
    case 'update':
      return '更新';
    case 'delete':
      return '删除';
    case 'set_status':
    case 'set_done':
      return '更新状态';
    case 'set_favorite':
      return '收藏';
    case 'restock':
      return '加入库存';
    case 'consume':
      return '扣减库存';
    case 'dispose':
      return '丢弃';
    case 'apply':
      return '应用';
    case 'cook':
      return '做菜';
    default:
      return '其他变更';
  }
}

function compositeDomainLabel(value: unknown) {
  switch (value) {
    case 'ingredient':
      return '食材信息';
    case 'inventory':
      return '库存';
    case 'food':
      return '食物信息';
    case 'recipe':
      return '菜谱';
    case 'recipe_cook':
      return '做菜';
    case 'meal_plan':
      return '餐食计划';
    case 'shopping_list':
      return '采购清单';
    case 'meal_log':
      return '餐食记录';
    default:
      return '相关内容';
  }
}

function compositeEntityLabel(value: unknown) {
  switch (value) {
    case 'Ingredient':
      return '食材信息';
    case 'InventoryItem':
      return '库存';
    case 'Food':
      return '食物信息';
    case 'Recipe':
      return '菜谱';
    case 'RecipeCookLog':
      return '做菜记录';
    case 'FoodPlanItem':
      return '餐食计划';
    case 'ShoppingListItem':
      return '待买内容';
    case 'MealLog':
      return '餐食记录';
    default:
      return '相关内容';
  }
}

function getImpact(step: Record<string, unknown>) {
  return typeof step.impact === 'object' && step.impact !== null && !Array.isArray(step.impact)
    ? step.impact as Record<string, unknown>
    : {};
}

function getDependencyRefs(step: Record<string, unknown>) {
  return asDraftArray(step.dependencyRefs);
}

function getDependsOn(step: Record<string, unknown>) {
  return Array.isArray(step.dependsOn) ? step.dependsOn.map(String).filter(Boolean) : [];
}

function isDangerousCompositeStep(step: Record<string, unknown>) {
  const action = asText(step.action);
  const impact = getImpact(step);
  const operationCount = asNumber(impact.operationCount, 0);
  return action === 'delete'
    || action === 'dispose'
    || asNumber(impact.deletes, 0) > 0
    || operationCount >= 5
    || Boolean(step.dangerous)
    || Boolean(impact.dangerous);
}

function compositeImpactKind(step: Record<string, unknown>) {
  const impact = getImpact(step);
  if (impact.creates) return '新增内容';
  if (impact.updates) return '更新内容';
  if (impact.deletes) return '删除内容';
  if (impact.operationCount) return '库存变更';
  return '内容变更';
}

function compositeStepUserTitle(step: Record<string, unknown>, index: number) {
  const title = asText(step.title);
  if (title) return title;
  const actionLabel = asText(step.actionLabel) || compositeStepActionLabel(step.action);
  return `${actionLabel}${compositeDomainLabel(step.domain)} · 第 ${index + 1} 步`;
}

function compositeDependencyText(step: Record<string, unknown>) {
  const dependencyRefs = getDependencyRefs(step);
  const dependsOn = getDependsOn(step);
  if (dependencyRefs.length === 0 && dependsOn.length === 0) return '';
  if (dependencyRefs.length > 0) {
    const labels = Array.from(new Set(dependencyRefs.map((item) => asText(item.stepId)).filter(Boolean)));
    return labels.length > 0
      ? `沿用前面步骤的结果：${labels.map((_, index) => `前一步结果 ${index + 1}`).join('、')}`
      : '沿用前面步骤的结果';
  }
  return `等待前面 ${dependsOn.length} 步完成后继续`;
}

function compositeStepImpactChips(step: Record<string, unknown>) {
  const impact = getImpact(step);
  const chips = [compositeImpactKind(step)];
  const operationCount = asNumber(impact.operationCount, 0);
  if (operationCount > 0) chips.push(`${operationCount} 项变更`);
  if (impact.usesDependencyResult) chips.push('沿用前一步结果');
  if (isDangerousCompositeStep(step)) chips.push('需要重点核对');
  return chips;
}

function compositeSummaryItems(steps: Record<string, unknown>[]) {
  const domains = new Set(steps.map((step) => compositeDomainLabel(step.domain)).filter(Boolean));
  const creates = steps.reduce((sum, step) => sum + asNumber(getImpact(step).creates, asText(step.action) === 'create' ? 1 : 0), 0);
  const updates = steps.reduce((sum, step) => sum + asNumber(getImpact(step).updates, ['update', 'set_status', 'set_done', 'set_favorite'].includes(asText(step.action)) ? 1 : 0), 0);
  const deletes = steps.reduce((sum, step) => sum + asNumber(getImpact(step).deletes, asText(step.action) === 'delete' ? 1 : 0), 0);
  const inventoryOperations = steps.reduce((sum, step) => sum + (asText(step.domain) === 'inventory' ? Math.max(1, asNumber(getImpact(step).operationCount, 1)) : 0), 0);
  const dangerCount = steps.filter(isDangerousCompositeStep).length;
  return [
    { label: '步骤', value: `${steps.length} 步` },
    { label: '涉及内容', value: domains.size > 0 ? Array.from(domains).join('、') : '相关内容' },
    { label: '变更概览', value: [`新增 ${creates}`, `更新 ${updates}`, `删除 ${deletes}`, `库存变更 ${inventoryOperations}`].join(' · ') },
    { label: '需要核对', value: dangerCount > 0 ? `${dangerCount} 步` : '无需特别核对' },
  ];
}

function compositeRiskText(steps: Record<string, unknown>[]) {
  const dangerCount = steps.filter(isDangerousCompositeStep).length;
  if (dangerCount > 0) {
    return `包含 ${dangerCount} 个需要重点核对的步骤，请留意删除、丢弃或一次处理多项内容。中途失败时，已完成的改动会自动撤回。`;
  }
  return '未检测到删除、丢弃或大量更新。确认后会按顺序处理；中途失败时，已完成的改动会自动撤回。';
}

function compositeResolvedTitle(status: string) {
  if (status === 'approved') return '这组变更已完成';
  if (status === 'rejected') return '这组变更未执行';
  if (status === 'expired') return '这组待确认变更已过期';
  return '一组待确认变更';
}

function compositeResolvedStatus(status: string): 'approved' | 'rejected' | 'expired' | 'cancelled' | 'canceled' {
  if (status === 'approved' || status === 'rejected' || status === 'expired' || status === 'cancelled' || status === 'canceled') {
    return status;
  }
  return 'expired';
}

export function validateCompositeOperationDraftForSubmit(draft: Record<string, unknown>) {
  const steps = getCompositeSteps(draft);
  if (steps.length === 0) return '这组变更至少需要 1 步';
  const invalidStep = steps.find((step, index) => !compositeStepUserTitle(step, index).trim() || !(asText(step.actionLabel) || compositeStepActionLabel(step.action)).trim());
  if (invalidStep) return '每一步都需要填写标题和操作名称';
  return '';
}

export function AiCompositeOperationPreview({
  draft,
  status = 'pending',
  readonly = false,
}: {
  draft: Record<string, unknown>;
  status?: string;
  readonly?: boolean;
}) {
  const steps = getCompositeSteps(draft);
  const summaryItems = compositeSummaryItems(steps);
  const hasDanger = steps.some(isDangerousCompositeStep);
  const isResolved = status !== 'pending';
  const summaryCopy = readonly
    ? '这里保留变更结果，方便回看每一步影响。'
    : '当前只能整体确认或拒绝这组变更。';
  const executionCopy = readonly
    ? '这里只展示变更结果，不能再修改。'
    : '请按顺序核对每一步影响。确认后会依次执行这些变更；中途失败时，已完成的改动会自动撤回。';
  const stepSection = (
    <AiDraftSection
      title={readonly ? '变更结果' : '变更顺序'}
      description={steps.length > 0 ? '会按下方顺序执行；需要前一步结果的内容会在前一步完成后继续。' : '当前没有可执行的步骤。'}
      className="ai-composite-operation-steps-section"
    >
      <AiDraftImpactNote tone="plan" title="变更说明" className="ai-composite-operation-note">
        <p>{executionCopy}</p>
      </AiDraftImpactNote>
      <div className="ai-composite-operation-list">
        {steps.length > 0 ? steps.map((step, index) => {
          const dependencyText = compositeDependencyText(step);
          const dangerous = isDangerousCompositeStep(step);
          const actionLabel = asText(step.actionLabel) || compositeStepActionLabel(step.action);
          return (
            <AiDraftItemCard
              key={asText(step.stepId) || `${index}`}
              title={compositeStepUserTitle(step, index)}
              summary={compositeDomainLabel(step.domain)}
              status={<span className={`ai-composite-operation-step-action${dangerous ? ' is-danger' : ''}`}>{actionLabel}</span>}
              tone={dangerous ? 'danger' : 'plan'}
              className={`ai-composite-operation-step${dangerous ? ' is-danger' : ''}`}
            >
              <div className="ai-composite-operation-step-body">
                <div className="ai-composite-operation-step-order" aria-hidden="true">{index + 1}</div>
                <div className="ai-composite-operation-step-content">
                  {asText(step.summary) ? <p className="ai-composite-operation-step-summary">{asText(step.summary)}</p> : null}
                  {dependencyText ? <p className="ai-composite-operation-step-dependency">{dependencyText}</p> : null}
                  <div className="ai-composite-operation-step-impact" aria-label="每步影响">
                    {compositeStepImpactChips(step).map((chip) => (
                      <span className={chip === '需要重点核对' ? 'is-danger' : ''} key={chip}>{chip}</span>
                    ))}
                  </div>
                  <details className="ai-composite-operation-technical-details">
                    <summary>查看影响范围</summary>
                    <div className="ai-composite-operation-step-meta">
                      <span>影响范围 · {compositeEntityLabel(step.affectedEntityType)}</span>
                    </div>
                  </details>
                </div>
              </div>
              {dangerous ? (
                <AiDraftImpactNote tone="danger" title="需要重点核对" className="ai-composite-operation-danger-impact">
                  <p>这一步会删除、丢弃或一次变更多项内容，确认后会一并执行。</p>
                </AiDraftImpactNote>
              ) : null}
            </AiDraftItemCard>
          );
        }) : (
          <AiDraftImpactNote tone="warning" title="还没有步骤预览">
            <p>当前没有可展示的分步影响信息。</p>
          </AiDraftImpactNote>
        )}
      </div>
    </AiDraftSection>
  );
  const riskSection = (
    <AiDraftSection
      title="风险提示"
      description={compositeRiskText(steps)}
      className="ai-composite-operation-risk-section"
    >
      <AiDraftImpactNote
        tone={hasDanger ? 'danger' : 'plan'}
        title={hasDanger ? '需要重点核对' : '风险较低'}
        className={`ai-composite-risk-card${hasDanger ? ' is-danger' : ''}`}
      >
        <p>{compositeRiskText(steps)}</p>
        <p className="ai-composite-risk-label">{hasDanger ? '需要重点核对' : '可整体确认'}</p>
      </AiDraftImpactNote>
    </AiDraftSection>
  );

  return (
    <div className="ai-recipe-editor ai-confirmation-editor ai-composite-operation-editor">
      {isResolved ? (
        <AiDraftResolvedSummary
          status={compositeResolvedStatus(status)}
          title={compositeResolvedTitle(status)}
          summary={summaryCopy}
          className="ai-composite-operation-summary-card"
        >
          <dl className="ai-draft-summary-items">
            {summaryItems.map((item) => (
              <div key={item.label} className="ai-draft-summary-item">
                <dt>{item.label}</dt>
                <dd>{item.value}</dd>
              </div>
            ))}
          </dl>
          {stepSection}
          {riskSection}
        </AiDraftResolvedSummary>
      ) : (
        <>
          <AiDraftSummaryCard
            title={compositeResolvedTitle(status)}
            items={summaryItems}
            className="ai-composite-operation-summary-card"
          />
          <AiDraftImpactNote tone="plan" title="确认前说明">
            <p>{summaryCopy}</p>
          </AiDraftImpactNote>
          {stepSection}
          {riskSection}
        </>
      )}
    </div>
  );
}
