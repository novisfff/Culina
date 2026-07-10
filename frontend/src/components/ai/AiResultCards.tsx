import type {
  AiGeneratedRecipeDraft,
  AiInventoryOperationAction,
  AiInventoryResultItem,
  AiResultCard,
  AiTodayRecommendationItem,
  AiUiActionsCardData,
  MediaAsset,
} from '../../api/types';
import { buildMediaSizes, buildMediaSrcSet, resolveMediaUrl } from '../../lib/assets';
import { MEAL_TYPE_LABELS } from '../../lib/ui';
import { MediaWithPlaceholder } from '../MediaPlaceholder';
import { approvalStatusText } from './AiApprovalPanel';
import {
  AI_RESULT_PLACEHOLDER,
  evidenceText,
  inventoryExpiryText,
  inventoryItems,
  inventoryStatusText,
  operationResultEntityLabel,
  operationResultEntities,
  operationResultOperationLabel,
  recommendationItems,
  recommendationMeta,
} from './AiResultCardModel';

export function ResultImage({ asset, alt }: { asset?: MediaAsset | null; alt: string }) {
  const imageSrc = resolveMediaUrl(asset, 'thumb');
  if (!imageSrc) {
    return <img className="ai-query-card-image" src={AI_RESULT_PLACEHOLDER} alt={alt} />;
  }
  return (
    <MediaWithPlaceholder
      className="ai-query-card-image"
      src={imageSrc}
      srcSet={buildMediaSrcSet(asset)}
      sizes={buildMediaSizes('thumb')}
      alt={alt}
      showLabel={false}
    />
  );
}

const INVENTORY_ACTION_LABELS: Record<AiInventoryOperationAction, string> = {
  restock: '补货',
  consume: '消耗',
  dispose: '销毁',
};

function InventoryCard({
  card,
  onInventoryAction,
  isInventoryActionPending,
}: {
  card: AiResultCard;
  onInventoryAction?: (item: AiInventoryResultItem, action: AiInventoryOperationAction, card: AiResultCard) => void;
  isInventoryActionPending?: boolean;
}) {
  const items = inventoryItems(card);
  return (
    <article className="ai-result-card ai-query-result-card ai-inventory-result-card">
      <header className="ai-query-card-head">
        <div className="ai-query-card-head-main">
          <span className="ai-query-card-eyebrow">家庭库存</span>
          <h3>{card.title}</h3>
        </div>
        <div className="ai-query-card-metrics" aria-label="库存统计">
          <span className="metric-available"><strong>{card.data.availableCount ?? 0}</strong>可用</span>
          <span className="metric-expiring"><strong>{card.data.expiringCount ?? 0}</strong>临期</span>
          <span className="metric-low"><strong>{card.data.lowStockCount ?? 0}</strong>低库存</span>
        </div>
      </header>
      {items.length > 0 ? (
        <div className="ai-query-item-grid ai-query-inventory-list">
          {items.slice(0, 6).map((item) => (
            <section className="ai-query-item" key={item.id}>
              <ResultImage asset={item.image} alt={item.name} />
              <div className="ai-query-item-copy">
                <div className="ai-query-item-title">
                  <strong>{item.name}</strong>
                  <span className={`ai-query-status tone-${item.displayStatus}`}>
                    {inventoryStatusText(item.displayStatus, item.daysUntilExpiry)}
                  </span>
                </div>
                <p>{item.quantity}{item.unit} · {inventoryExpiryText(item)}</p>
                {item.lastOperation && (
                  <p className={`ai-query-inventory-result tone-${item.lastOperation.action}`}>
                    已{INVENTORY_ACTION_LABELS[item.lastOperation.action]}
                    {item.lastOperation.quantity ? ` ${item.lastOperation.quantity}${item.lastOperation.unit ?? item.unit}` : ''}
                  </p>
                )}
              </div>
              {item.sourceType === 'ingredient' && item.suggestedAction && (
                <div className="ai-query-inventory-actions" aria-label={`${item.name}建议操作`}>
                  <button
                    className={`ghost-button action-${item.suggestedAction}`}
                    type="button"
                    disabled={
                      isInventoryActionPending
                      || !onInventoryAction
                      || (item.suggestedAction !== 'restock' && Number(item.quantity) <= 0)
                    }
                    onClick={() => onInventoryAction?.(item, item.suggestedAction!, card)}
                  >
                    {INVENTORY_ACTION_LABELS[item.suggestedAction]}
                  </button>
                </div>
              )}
            </section>
          ))}
        </div>
      ) : (
        <div className="ai-query-empty">
          <strong>当前没有可展示的库存</strong>
          <span>库存为空，或没有符合本次查询条件的食材。</span>
        </div>
      )}
    </article>
  );
}

function RecommendationCard({
  card,
  onAddToPlan,
}: {
  card: AiResultCard;
  onAddToPlan?: (item: AiTodayRecommendationItem, card: AiResultCard) => void;
}) {
  const recommendations = recommendationItems(card);
  const context = card.data.contextSummary;
  return (
    <article className="ai-result-card ai-query-result-card">
      <header className="ai-query-card-head">
        <div className="ai-query-card-head-main">
          <span className="ai-query-card-eyebrow">基于家庭数据</span>
          <h3>{card.title}</h3>
        </div>
        <div className="ai-query-card-context-badges">
          <span className="ai-query-context-badge">
            库存 <strong>{context?.inventoryCount ?? 0}</strong>
          </span>
          <span className="ai-query-context-badge">
            临期 <strong className={context?.expiringCount && context.expiringCount > 0 ? "text-warning" : ""}>{context?.expiringCount ?? 0}</strong>
          </span>
          <span className="ai-query-context-badge">
            菜谱 <strong>{context?.recipeCount ?? 0}</strong>
          </span>
        </div>
      </header>
      {recommendations.length > 0 ? (
        <div className="ai-query-item-grid ai-query-recommendation-list">
          {recommendations.map((item) => {
            const evidence = evidenceText(item);
            return (
              <section className="ai-query-item ai-query-recommendation" key={`${item.entityType}-${item.entityId}`}>
                <ResultImage asset={item.image} alt={item.name} />
                <div className="ai-query-item-copy">
                  <div className="ai-query-item-title">
                    <strong>{item.name}</strong>
                    <span className="ai-query-kind">{item.entityType === 'recipe' ? '菜谱' : '食物'}</span>
                  </div>
                  {recommendationMeta(item) && <p>{recommendationMeta(item)}</p>}
                  <p className="ai-query-reason">{item.reason}</p>
                  {evidence.length > 0 && (
                    <div className="ai-query-evidence">
                      {evidence.map((value) => <span key={value}>{value}</span>)}
                    </div>
                  )}
                </div>
                <div className="ai-query-item-action">
                  {item.planSelection ? (
                    <div className="ai-query-plan-added" aria-label="已加入菜单计划">
                      <strong>
                        <svg className="added-icon" viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round" style={{ marginRight: '4px', display: 'inline-block', verticalAlign: 'middle' }}>
                          <polyline points="20 6 9 17 4 12"></polyline>
                        </svg>
                        已加入菜单
                      </strong>
                      <span>{item.planSelection.planDate} · {MEAL_TYPE_LABELS[item.planSelection.mealType]}</span>
                    </div>
                  ) : (
                    <button
                      className="solid-button"
                      type="button"
                      disabled={!item.foodId || !onAddToPlan}
                      title={item.foodId ? '加入菜单计划' : '需要先关联食物'}
                      onClick={() => onAddToPlan?.(item, card)}
                    >
                      <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ marginRight: '4px', display: 'inline-block', verticalAlign: 'middle' }}>
                        <line x1="12" y1="5" x2="12" y2="19"></line>
                        <line x1="5" y1="12" x2="19" y2="12"></line>
                      </svg>
                      {item.foodId ? '加入菜单计划' : '需关联食物'}
                    </button>
                  )}
                </div>
              </section>
            );
          })}
        </div>
      ) : (
        <div className="ai-query-empty">
          <strong>暂时没有合适的推荐</strong>
          <span>当前食物或菜谱资料不足，可以先补充家庭食物库。</span>
        </div>
      )}
    </article>
  );
}

function ClarificationCard({ card }: { card: AiResultCard }) {
  const question = typeof card.data.question === 'string' ? card.data.question : '请补充必要信息。';
  const missingFields = Array.isArray(card.data.missingFields) ? card.data.missingFields.filter((item): item is string => typeof item === 'string' && item.length > 0) : [];
  const candidates = Array.isArray(card.data.candidates)
    ? card.data.candidates.filter(
      (item): item is { id: string; label: string; summary?: string | null; entityType?: string | null; updatedAt?: string | null } =>
        Boolean(item) && typeof item === 'object' && typeof item.id === 'string' && typeof item.label === 'string',
    )
    : [];

  return (
    <article className="ai-result-card ai-query-result-card ai-clarification-card">
      <header className="ai-query-card-head">
        <div>
          <span className="ai-query-card-eyebrow">需要确认</span>
          <h3>{card.title}</h3>
        </div>
      </header>
      <p className="ai-query-reason">{question}</p>
      {missingFields.length > 0 && (
        <div className="ai-query-evidence" aria-label="待补充信息">
          {missingFields.map((field) => <span key={field}>{field}</span>)}
        </div>
      )}
      {candidates.length > 0 && (
        <div className="ai-clarification-options" aria-label="可选项">
          {candidates.map((item, index) => (
            <section key={item.id} className="ai-clarification-option">
              <span className="ai-clarification-option-index">选项 {index + 1}</span>
              <strong>{item.label}</strong>
              <p>{[item.summary, item.updatedAt ? `更新于 ${item.updatedAt}` : null].filter(Boolean).join(' · ')}</p>
            </section>
          ))}
        </div>
      )}
      <p className="subtle">{candidates.length > 0 ? '直接回复选项编号、名称或补充信息即可。' : '直接回复你的选择或补充信息即可。'}</p>
    </article>
  );
}

function OperationResultCard({ card }: { card: AiResultCard }) {
  const entities = operationResultEntities(card);
  const actionSummary = typeof card.data.actionSummary === 'string' ? card.data.actionSummary.trim() : '';
  const entityCountLabel = typeof card.data.entityCountLabel === 'string' ? card.data.entityCountLabel : `${entities.length} 个实体`;
  const workspaceLabel = typeof card.data.workspaceLabel === 'string' ? card.data.workspaceLabel : '对应页面';
  const workspaceHint = typeof card.data.workspaceHint === 'string' ? card.data.workspaceHint : `可前往${workspaceLabel}查看`;
  const normalizedTitle = card.title.replace(/\s+/g, '');
  const normalizedSummary = actionSummary.replace(/\s+/g, '');
  const shouldShowActionSummary = Boolean(actionSummary) && normalizedSummary !== normalizedTitle;
  const shouldShowEntityCount = entities.length > 0 || (typeof card.data.entityCount === 'number' && card.data.entityCount > 0);
  const destinationText = workspaceHint.trim();

  return (
    <article className="ai-result-card ai-query-result-card ai-operation-result-card">
      <header className="ai-query-card-head">
        <div className="ai-query-card-head-main">
          <span className="ai-query-card-eyebrow">已按确认执行</span>
          <h3>{card.title}</h3>
        </div>
        {shouldShowEntityCount && (
          <div className="ai-query-card-context-badges">
            <span className="ai-query-context-badge">
              影响 <strong>{entityCountLabel}</strong>
            </span>
          </div>
        )}
      </header>
      {shouldShowActionSummary && <p className="ai-query-reason">{actionSummary}</p>}
      {entities.length > 0 && (
        <div className="ai-query-recommendation-list" aria-label="已执行实体">
          {entities.map((item) => (
            <section key={item.id} className="ai-recommendation-item">
              <strong>{operationResultEntityLabel(item)}</strong>
              <p>
                {[operationResultOperationLabel(item), item.updatedAt ? `更新于 ${item.updatedAt}` : null].filter(Boolean).join(' · ')}
              </p>
            </section>
          ))}
        </div>
      )}
      {destinationText && (
        <div className="ai-operation-result-footer" aria-label="查看提示">
          <span>查看位置</span>
          <strong>{workspaceLabel}</strong>
          {destinationText !== `可前往${workspaceLabel}查看` && <small>{destinationText}</small>}
        </div>
      )}
    </article>
  );
}

function UiActionsCard({ card }: { card: AiResultCard }) {
  const data = card.data as Partial<AiUiActionsCardData>;
  const actions = Array.isArray(data.actions) ? data.actions : [];
  return (
    <article className="ai-result-card ai-query-result-card ai-ui-actions-card">
      <header className="ai-query-card-head">
        <div className="ai-query-card-head-main">
          <span className="ai-query-card-eyebrow">页面助手</span>
          <h3>{card.title}</h3>
        </div>
        <div className="ai-query-card-context-badges">
          <span className="ai-query-context-badge">
            动作 <strong>{actions.length}</strong>
          </span>
        </div>
      </header>
      <p className="ai-query-reason">页面动作需要在对应页面中执行。</p>
      <p className="subtle">请回到对应做菜页面执行这些操作。</p>
    </article>
  );
}

export function ResultCard({
  card,
  onAddToPlan,
  onInventoryAction,
  isInventoryActionPending,
}: {
  card: AiResultCard;
  onAddToPlan?: (item: AiTodayRecommendationItem, card: AiResultCard) => void;
  onInventoryAction?: (item: AiInventoryResultItem, action: AiInventoryOperationAction, card: AiResultCard) => void;
  isInventoryActionPending?: boolean;
}) {
  if (card.type === 'inventory_summary') {
    return (
      <InventoryCard
        card={card}
        onInventoryAction={onInventoryAction}
        isInventoryActionPending={isInventoryActionPending}
      />
    );
  }
  if (card.type === 'today_recommendation') return <RecommendationCard card={card} onAddToPlan={onAddToPlan} />;
  if ((card.type as string) === 'clarification_request') return <ClarificationCard card={card} />;
  if (card.type === 'operation_result') return <OperationResultCard card={card} />;
  if (card.type === 'ui_actions') return <UiActionsCard card={card} />;

  if (card.type === 'recipe_draft') {
    const draft = card.data.draft as AiGeneratedRecipeDraft | undefined;
    return (
      <article className="ai-result-card ai-recipe-draft-card">
        <div className="inline-between">
          <h3>{card.title}</h3>
          <span className="subtle">{String(card.data.summary ?? '')}</span>
        </div>
        {draft && (
          <div className="ai-recipe-draft-summary">
            <span>{draft.servings} 人份</span>
            <span>{draft.prep_minutes} 分钟</span>
            <span>{draft.difficulty}</span>
            <span>{draft.ingredient_items.length} 个食材</span>
            <span>{draft.steps.length} 个步骤</span>
          </div>
        )}
      </article>
    );
  }

  if (card.type === 'approval_request') {
    const statusText = typeof card.data.status === 'string' ? card.data.status : 'pending';
    const instruction = typeof card.data.instruction === 'string' ? card.data.instruction : '等待你确认后再执行写入。';
    return (
      <article className="ai-result-card ai-approval-card">
        <div className="inline-between">
          <h3>{card.title}</h3>
          <span className={`ai-approval-status status-${statusText}`}>{approvalStatusText(statusText)}</span>
        </div>
        <p>{instruction}</p>
      </article>
    );
  }

  if (card.type === 'meal_plan_draft' || card.type === 'shopping_list_draft' || card.type === 'meal_log_draft' || card.type === 'food_profile_draft') {
    const items = Array.isArray(card.data.items) ? card.data.items : Array.isArray(card.data.foods) ? card.data.foods : [];
    return (
      <article className="ai-result-card">
        <div className="inline-between">
          <h3>{card.title}</h3>
          <span className="subtle">{String(card.data.summary ?? '')}</span>
        </div>
        <div className="ai-recommendation-list">
          {items.slice(0, 6).map((item, index) => {
            const value = item as { title?: string; name?: string; reason?: string; note?: string; date?: string; mealType?: string };
            return (
              <section key={`${value.title ?? value.name ?? 'draft'}-${index}`} className="ai-recommendation-item">
                <strong>{value.title ?? value.name ?? '草稿项'}</strong>
                <p>{value.reason ?? value.note ?? [value.date, value.mealType].filter(Boolean).join(' · ')}</p>
              </section>
            );
          })}
        </div>
      </article>
    );
  }

  return (
    <article className="ai-result-card ai-error-card">
      <h3>{card.title}</h3>
      <p>{String(card.data.message ?? '请稍后重试。')}</p>
    </article>
  );
}
