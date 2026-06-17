function asText(value: unknown, fallback = '') {
  return typeof value === 'string' ? value : fallback;
}

function getCompositeSteps(draft: Record<string, unknown>) {
  const fromPreview = Array.isArray(draft.stepPreviews)
    ? draft.stepPreviews
    : Array.isArray(draft.steps)
      ? draft.steps
      : [];
  return fromPreview.filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null && !Array.isArray(item));
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

export function AiCompositeOperationPreview({ draft }: { draft: Record<string, unknown> }) {
  const steps = getCompositeSteps(draft);
  return (
    <div className="ai-recipe-editor ai-confirmation-editor ai-composite-operation-editor">
      <div className="ai-draft-editor-head">
        <div>
          <strong>复合步骤预览</strong>
          <span>{steps.length} 步</span>
        </div>
      </div>
      <p className="ai-composite-operation-note">
        这里展示的是分步影响预览。确认后会按顺序执行已接入的基础业务步骤，任一步失败都会回滚已完成步骤。
      </p>
      <div className="ai-composite-operation-list">
        {steps.length > 0 ? steps.map((step, index) => {
          const impact = typeof step.impact === 'object' && step.impact !== null && !Array.isArray(step.impact)
            ? step.impact as Record<string, unknown>
            : {};
          const dependencyRefs = Array.isArray(step.dependencyRefs)
            ? step.dependencyRefs.filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null && !Array.isArray(item))
            : [];
          const dependsOn = Array.isArray(step.dependsOn) ? step.dependsOn.map(String).filter(Boolean) : [];
          const impactKind = impact.creates ? '新增业务数据' : impact.updates ? '更新业务数据' : impact.deletes ? '删除业务数据' : '处理业务数据';
          return (
            <article className="ai-composite-operation-step" key={asText(step.stepId) || `${index}`}>
              <div className="ai-composite-operation-step-head">
                <div>
                  <strong>{asText(step.title) || `步骤 ${index + 1}`}</strong>
                  <span>{asText(step.domainLabel) || asText(step.domain)}</span>
                </div>
                <span className="ai-composite-operation-step-action">
                  {asText(step.actionLabel) || compositeStepActionLabel(step.action)}
                </span>
              </div>
              {asText(step.summary) && <p className="ai-composite-operation-step-summary">{asText(step.summary)}</p>}
              <div className="ai-composite-operation-step-meta">
                <span>步骤 ID · {asText(step.stepId) || `step-${index + 1}`}</span>
                <span>影响 · {asText(step.affectedEntityType) || '业务实体'}</span>
                {dependsOn.length > 0 && <span>依赖 · {dependsOn.join('、')}</span>}
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
              <div className="ai-composite-operation-step-impact">
                <span>{impactKind}</span>
                {impact.operationCount ? <span>{String(impact.operationCount)} 个子操作</span> : null}
                {impact.usesDependencyResult ? <span>引用前置步骤结果</span> : null}
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
    </div>
  );
}
