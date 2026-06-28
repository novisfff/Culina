import { asDraftArray, asNumber, asText } from './aiDraftValueUtils';

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
      return '状态变更';
    case 'set_favorite':
      return '收藏';
    case 'restock':
      return '入库';
    case 'consume':
      return '消耗';
    case 'dispose':
      return '销毁';
    case 'apply':
      return '应用';
    case 'cook':
      return '做菜';
    default:
      return typeof value === 'string' && value ? value : '操作';
  }
}

function compositeDomainLabel(value: unknown) {
  switch (value) {
    case 'ingredient':
      return '食材档案';
    case 'inventory':
      return '库存';
    case 'food':
      return '食物资料';
    case 'recipe':
      return '菜谱';
    case 'recipe_cook':
      return '做菜';
    case 'meal_plan':
      return '餐食计划';
    case 'shopping_list':
      return '购物清单';
    case 'meal_log':
      return '餐食记录';
    default:
      return asText(value) || '业务步骤';
  }
}

function compositeEntityLabel(value: unknown) {
  switch (value) {
    case 'Ingredient':
      return '食材档案';
    case 'InventoryItem':
      return '库存批次';
    case 'Food':
      return '食物资料';
    case 'Recipe':
      return '菜谱';
    case 'RecipeCookLog':
      return '做菜记录';
    case 'FoodPlanItem':
      return '餐食计划';
    case 'ShoppingListItem':
      return '购物项';
    case 'MealLog':
      return '餐食记录';
    default:
      return asText(value) || '业务数据';
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
  if (impact.creates) return '新增业务数据';
  if (impact.updates) return '更新业务数据';
  if (impact.deletes) return '删除业务数据';
  if (impact.operationCount) return '处理库存或批量操作';
  return '处理业务数据';
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
      ? `使用前面步骤创建或更新的结果：${labels.map((_, index) => `上一步结果 ${index + 1}`).join('、')}`
      : '使用前面步骤创建或更新的结果';
  }
  return `等待前面 ${dependsOn.length} 步完成后执行`;
}

function compositeStepImpactChips(step: Record<string, unknown>) {
  const impact = getImpact(step);
  const chips = [compositeImpactKind(step)];
  const operationCount = asNumber(impact.operationCount, 0);
  if (operationCount > 0) chips.push(`${operationCount} 个子操作`);
  if (impact.usesDependencyResult) chips.push('使用前置结果');
  if (isDangerousCompositeStep(step)) chips.push('需重点核对');
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
    { label: '涉及领域', value: domains.size > 0 ? Array.from(domains).join('、') : '未识别' },
    { label: '写入影响', value: [`新增 ${creates}`, `更新 ${updates}`, `删除 ${deletes}`, `库存 ${inventoryOperations}`].join(' · ') },
    { label: '风险步骤', value: dangerCount > 0 ? `${dangerCount} 步需核对` : '无高风险' },
  ];
}

function compositeRiskText(steps: Record<string, unknown>[]) {
  const dangerCount = steps.filter(isDangerousCompositeStep).length;
  if (dangerCount > 0) {
    return `包含 ${dangerCount} 个高风险步骤，请重点核对删除、销毁或批量操作。任一步失败时会回滚已完成步骤。`;
  }
  return '未检测到删除、销毁或大批量更新步骤。确认后会按顺序执行，任一步失败时回滚已完成步骤。';
}

function compositeResolvedTitle(status: string) {
  if (status === 'approved') return '复合操作已执行';
  if (status === 'rejected') return '未执行的复合操作草稿';
  if (status === 'expired') return '已过期的复合操作草稿';
  return '待确认复合操作';
}

export function validateCompositeOperationDraftForSubmit(draft: Record<string, unknown>) {
  const steps = getCompositeSteps(draft);
  if (steps.length === 0) return '复合操作至少需要 1 个步骤';
  const invalidStep = steps.find((step, index) => !compositeStepUserTitle(step, index).trim() || !(asText(step.actionLabel) || compositeStepActionLabel(step.action)).trim());
  if (invalidStep) return '每个复合操作步骤都需要用户可读标题和动作标签';
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

  return (
    <div className="ai-recipe-editor ai-confirmation-editor ai-composite-operation-editor">
      <section className="ai-composite-operation-summary-card" aria-label="复合操作总览">
        <div className="ai-recipe-summary-head">
          <div>
            <strong>{compositeResolvedTitle(status)}</strong>
            <span>{readonly ? '保留执行结果摘要，便于回看每一步影响。' : '第一阶段只支持整体确认或拒绝；子步骤暂不单独编辑。'}</span>
          </div>
          <em>复合</em>
        </div>
        <dl className="ai-recipe-summary-grid ai-composite-operation-summary-grid">
          {summaryItems.map((item) => (
            <div key={item.label}>
              <dt>{item.label}</dt>
              <dd>{item.value}</dd>
            </div>
          ))}
        </dl>
      </section>

      <div className="ai-composite-section-heading">
        <strong>{readonly ? '执行结果' : '执行顺序'}</strong>
        <span>{steps.length > 0 ? '按下方顺序依次执行，依赖步骤会等待前置结果。' : '当前草稿没有可执行步骤。'}</span>
      </div>

      <p className="ai-composite-operation-note">
        {readonly ? '这是一份只读的执行摘要。' : '请按顺序核对每一步影响。确认后会按顺序执行已接入的基础业务步骤，任一步失败都会回滚已完成步骤。'}
      </p>

      <div className="ai-composite-operation-list">
        {steps.length > 0 ? steps.map((step, index) => {
          const dependencyRefs = getDependencyRefs(step);
          const dependencyText = compositeDependencyText(step);
          const dangerous = isDangerousCompositeStep(step);
          return (
            <article className={`ai-composite-operation-step${dangerous ? ' is-danger' : ''}`} key={asText(step.stepId) || `${index}`}>
              <div className="ai-composite-operation-step-order" aria-hidden="true">{index + 1}</div>
              <div className="ai-composite-operation-step-content">
                <div className="ai-composite-operation-step-head">
                  <div>
                    <strong>{compositeStepUserTitle(step, index)}</strong>
                    <span>{compositeDomainLabel(step.domain)}</span>
                  </div>
                  <span className={`ai-composite-operation-step-action${dangerous ? ' is-danger' : ''}`}>
                    {asText(step.actionLabel) || compositeStepActionLabel(step.action)}
                  </span>
                </div>
                {asText(step.summary) && <p className="ai-composite-operation-step-summary">{asText(step.summary)}</p>}
                {dependencyText && <p className="ai-composite-operation-step-dependency">{dependencyText}</p>}
                <div className="ai-composite-operation-step-impact" aria-label="每步影响">
                  {compositeStepImpactChips(step).map((chip) => (
                    <span className={chip === '需重点核对' ? 'is-danger' : ''} key={chip}>{chip}</span>
                  ))}
                </div>
                <details className="ai-composite-operation-technical-details">
                  <summary>工程详情</summary>
                  <div className="ai-composite-operation-step-meta">
                    <span>步骤 ID · {asText(step.stepId) || `step-${index + 1}`}</span>
                    <span>影响对象 · {compositeEntityLabel(step.affectedEntityType)}</span>
                    {getDependsOn(step).length > 0 && <span>依赖步骤 · {getDependsOn(step).join('、')}</span>}
                  </div>
                  {dependencyRefs.length > 0 && (
                    <div className="ai-composite-operation-step-deps" aria-label="依赖引用">
                      {dependencyRefs.map((item, depIndex) => (
                        <span key={`${asText(item.stepId)}-${asText(item.path)}-${depIndex}`}>
                          {asText(item.stepId)} · {asText(item.path)}
                        </span>
                      ))}
                    </div>
                  )}
                </details>
              </div>
            </article>
          );
        }) : (
          <div className="ai-confirmation-summary-card">
            <strong>暂无步骤预览</strong>
            <p>当前草稿没有可展示的分步影响信息。</p>
          </div>
        )}
      </div>

      <div className="ai-composite-section-heading">
        <strong>风险与回滚</strong>
        <span>{compositeRiskText(steps)}</span>
      </div>
      <div className={`ai-composite-risk-card${hasDanger ? ' is-danger' : ''}`}>
        <div>
          <strong>{hasDanger ? '需要重点核对' : '风险较低'}</strong>
          <span>{compositeRiskText(steps)}</span>
        </div>
        <em>{hasDanger ? '危险步骤' : '可整体确认'}</em>
      </div>
    </div>
  );
}
