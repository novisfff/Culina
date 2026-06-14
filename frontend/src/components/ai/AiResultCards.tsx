import type {
  AiGeneratedRecipeDraft,
  AiInventoryOperationAction,
  AiInventoryResultItem,
  AiResultCard,
  AiTodayRecommendationItem,
  MediaAsset,
} from '../../api/types';
import { buildMediaSizes, buildMediaSrcSet, resolveMediaUrl } from '../../lib/assets';
import { MEAL_TYPE_LABELS } from '../../lib/ui';
import { approvalStatusText } from './AiApprovalPanel';
import {
  AI_RESULT_PLACEHOLDER,
  evidenceText,
  inventoryExpiryText,
  inventoryItems,
  inventoryStatusText,
  recommendationItems,
  recommendationMeta,
} from './AiResultCardModel';

export function ResultImage({ asset, alt }: { asset?: MediaAsset | null; alt: string }) {
  return (
    <img
      className="ai-query-card-image"
      src={resolveMediaUrl(asset, 'thumb') ?? AI_RESULT_PLACEHOLDER}
      srcSet={buildMediaSrcSet(asset)}
      sizes={buildMediaSizes('thumb')}
      alt={alt}
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
        <div>
          <span className="ai-query-card-eyebrow">家庭库存</span>
          <h3>{card.title}</h3>
        </div>
        <div className="ai-query-card-metrics" aria-label="库存统计">
          <span><strong>{card.data.availableCount ?? 0}</strong>可用</span>
          <span><strong>{card.data.expiringCount ?? 0}</strong>临期</span>
          <span><strong>{card.data.lowStockCount ?? 0}</strong>低库存</span>
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
              {item.suggestedAction && (
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
        <div>
          <span className="ai-query-card-eyebrow">基于家庭数据</span>
          <h3>{card.title}</h3>
        </div>
        <p className="ai-query-card-context">
          库存 {context?.inventoryCount ?? 0} · 临期 {context?.expiringCount ?? 0} · 菜谱 {context?.recipeCount ?? 0}
        </p>
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
                      <strong>已加入菜单</strong>
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
