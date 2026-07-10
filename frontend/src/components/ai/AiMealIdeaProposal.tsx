import type { AiMealIdeaIngredient, AiProductLoopPrompt, AiResultCard } from '../../api/types';

function mealIdeaIngredients(card: AiResultCard): AiMealIdeaIngredient[] {
  const rawItems = Array.isArray(card.data.ingredients) ? card.data.ingredients as unknown[] : [];
  return rawItems
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
    .map((item) => ({
      ingredientId: typeof item.ingredientId === 'string' ? item.ingredientId : '',
      name: typeof item.name === 'string' ? item.name : '未命名食材',
      quantityMode: item.quantityMode === 'not_track_quantity' ? 'not_track_quantity' as const : 'track_quantity' as const,
      availableQuantity: typeof item.availableQuantity === 'string' ? item.availableQuantity : null,
      unit: typeof item.unit === 'string' ? item.unit : null,
      available: item.available === true,
    }))
    .filter((item) => item.ingredientId);
}

export function AiMealIdeaProposal({
  card,
  onProductLoopPrompt,
  disabled,
}: {
  card: AiResultCard;
  onProductLoopPrompt?: (prompt: AiProductLoopPrompt) => void;
  disabled?: boolean;
}) {
  const title = typeof card.data.title === 'string' ? card.data.title : card.title;
  const reason = typeof card.data.reason === 'string' ? card.data.reason : '';
  const preparationSummary = typeof card.data.preparationSummary === 'string' ? card.data.preparationSummary : '';
  const ingredients = mealIdeaIngredients(card);
  const ingredientIds = ingredients.map((item) => item.ingredientId);
  const submit = () => {
    if (!onProductLoopPrompt || ingredientIds.length === 0) return;
    onProductLoopPrompt({
      message: '把这个想法整理成菜谱',
      quick_task: 'recipe_draft',
      subject: {
        source: 'meal_idea_proposal',
        ingredient_ids: ingredientIds,
        extra: {
          mealIdea: {
            schemaVersion: 'meal_idea_subject.v1',
            title,
            ingredientIds,
            reason,
            preparationSummary,
          },
        },
      },
    });
  };

  return (
    <article className="ai-result-card ai-query-result-card ai-meal-idea-card">
      <header className="ai-query-card-head">
        <div className="ai-query-card-head-main">
          <span className="ai-query-card-eyebrow">库存餐食想法</span>
          <h3>{title}</h3>
        </div>
        <div className="ai-query-card-context-badges">
          <span className="ai-query-context-badge">真实食材 <strong>{ingredients.length}</strong> 项</span>
        </div>
      </header>
      {reason && <p className="ai-query-reason">{reason}</p>}
      <div className="ai-meal-idea-ingredients" aria-label="餐食想法食材">
        {ingredients.map((item) => (
          <section key={item.ingredientId} className="ai-meal-idea-ingredient">
            <strong>{item.name}</strong>
            <span className={item.available ? 'is-available' : 'is-missing'}>
              {item.available
                ? item.quantityMode === 'track_quantity'
                  ? `库存 ${item.availableQuantity ?? '0'}${item.unit ?? ''}`
                  : '当前已有'
                : '当前库存不足'}
            </span>
          </section>
        ))}
      </div>
      {preparationSummary && <p className="ai-meal-idea-preparation">{preparationSummary}</p>}
      <div className="ai-query-item-action">
        <button
          className="solid-button"
          type="button"
          disabled={disabled || !onProductLoopPrompt || ingredientIds.length === 0}
          onClick={submit}
        >
          整理成菜谱
        </button>
      </div>
    </article>
  );
}
