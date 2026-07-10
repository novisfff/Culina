import { useState } from 'react';
import type { AiInventoryIntakeCandidate, AiProductLoopPrompt, AiResultCard } from '../../api/types';

function intakeCandidates(card: AiResultCard): AiInventoryIntakeCandidate[] {
  if (!Array.isArray(card.data.items)) return [];
  const rawItems = card.data.items as unknown[];
  return rawItems
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
    .map((item) => ({
      ingredientId: typeof item.ingredientId === 'string' ? item.ingredientId : '',
      name: typeof item.name === 'string' ? item.name : '未命名食材',
      quantityMode: item.quantityMode === 'not_track_quantity' ? 'not_track_quantity' as const : 'track_quantity' as const,
      quantity: typeof item.quantity === 'string' ? item.quantity : null,
      unit: typeof item.unit === 'string' ? item.unit : null,
      selected: item.selected !== false,
      warnings: Array.isArray(item.warnings) ? item.warnings.map(String) : [],
      confidence: typeof item.confidence === 'number' ? item.confidence : null,
      sourceLabel: typeof item.sourceLabel === 'string' ? item.sourceLabel : null,
    }))
    .filter((item) => item.ingredientId);
}

export function AiInventoryIntakeCandidates({
  card,
  onProductLoopPrompt,
  disabled,
}: {
  card: AiResultCard;
  onProductLoopPrompt?: (prompt: AiProductLoopPrompt) => void;
  disabled?: boolean;
}) {
  const [items, setItems] = useState(() => intakeCandidates(card));
  const unresolvedLabels = Array.isArray(card.data.unresolvedLabels)
    ? card.data.unresolvedLabels.map(String).filter(Boolean)
    : [];
  const selectedItems = items.filter((item) => item.selected);
  const hasInvalidQuantity = selectedItems.some((item) => (
    item.quantityMode === 'track_quantity'
    && (!item.quantity || !Number.isFinite(Number(item.quantity)) || Number(item.quantity) <= 0)
  ));
  const updateItem = (index: number, patch: Partial<AiInventoryIntakeCandidate>) => {
    setItems((current) => current.map((item, itemIndex) => (itemIndex === index ? { ...item, ...patch } : item)));
  };
  const submit = () => {
    if (!onProductLoopPrompt || selectedItems.length === 0 || hasInvalidQuantity) return;
    onProductLoopPrompt({
      message: '按这些项目准备入库',
      quick_task: 'inventory_analysis',
      subject: {
        source: 'inventory_intake_candidates',
        extra: {
          intakeCandidates: selectedItems.map((item) => ({
            ingredientId: item.ingredientId,
            quantity: item.quantityMode === 'track_quantity' ? item.quantity : null,
            unit: item.unit,
          })),
          unresolvedLabels,
        },
      },
    });
  };

  return (
    <article className="ai-result-card ai-query-result-card ai-inventory-intake-card">
      <header className="ai-query-card-head">
        <div className="ai-query-card-head-main">
          <span className="ai-query-card-eyebrow">入库候选</span>
          <h3>{card.title}</h3>
        </div>
        <div className="ai-query-card-context-badges">
          <span className="ai-query-context-badge">已选 <strong>{selectedItems.length}</strong> 项</span>
        </div>
      </header>
      <div className="ai-inventory-intake-list" aria-label="可审阅入库候选">
        {items.map((item, index) => (
          <section className="ai-inventory-intake-item" key={item.ingredientId}>
            <label className="ai-inventory-intake-select">
              <input
                type="checkbox"
                checked={item.selected}
                disabled={disabled}
                onChange={(event) => updateItem(index, { selected: event.target.checked })}
              />
              <span>
                <strong>{item.name}</strong>
                {item.sourceLabel && <small>识别为：{item.sourceLabel}</small>}
              </span>
            </label>
            {item.quantityMode === 'track_quantity' ? (
              <div className="ai-inventory-intake-quantity">
                <label>
                  <span>数量</span>
                  <input
                    className="text-input"
                    type="number"
                    min={0.1}
                    step={0.1}
                    value={item.quantity ?? ''}
                    disabled={disabled || !item.selected}
                    onChange={(event) => updateItem(index, { quantity: event.target.value })}
                  />
                </label>
                <span className="ai-inventory-intake-unit">{item.unit || '未设置单位'}</span>
              </div>
            ) : (
              <p className="subtle">只记录已有，不填写数量</p>
            )}
            {item.warnings.map((warning) => <p className="ai-inventory-intake-warning" key={warning}>{warning}</p>)}
          </section>
        ))}
      </div>
      {unresolvedLabels.length > 0 && (
        <div className="ai-inventory-intake-unresolved">
          <strong>还需确认</strong>
          <span>{unresolvedLabels.join('、')}</span>
        </div>
      )}
      <div className="ai-query-item-action">
        <button
          className="solid-button"
          type="button"
          disabled={disabled || !onProductLoopPrompt || selectedItems.length === 0 || hasInvalidQuantity}
          onClick={submit}
        >
          按选中项准备入库
        </button>
      </div>
    </article>
  );
}
