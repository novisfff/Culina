import { useMemo, useState } from 'react';

import { asDraftArray, asText } from './aiDraftValueUtils';

type DraftRecord = Record<string, unknown>;

type AiShoppingIntakeApprovalProps = {
  draft: DraftRecord;
  readonly: boolean;
  onChange: (draft: DraftRecord) => void;
};

function itemId(item: DraftRecord) {
  return asText(item.shoppingItemId);
}

function isQuantityTarget(item: DraftRecord) {
  const kind = asText(item.targetKind);
  return asText(item.action) === 'stock_and_fulfill' && (kind === 'exact_ingredient' || kind === 'food');
}

function quantityValue(item: DraftRecord) {
  const value = item.enteredQuantity;
  return value === null || value === undefined ? '' : String(value);
}

function needsAttention(item: DraftRecord) {
  if (asText(item.matchLevel) !== 'confirmed') return true;
  if (isQuantityTarget(item) && !quantityValue(item).trim()) return true;
  if (item.packageConversion) return true;
  if (asText(item.action) === 'stock_and_fulfill' && !asText(item.storageLocation)) return true;
  return false;
}

function displayQuantity(value: number) {
  return String(Number(value.toFixed(4)));
}

function canonicalActual(item: DraftRecord) {
  const rawEntered = quantityValue(item).trim();
  const entered = Number(rawEntered);
  if (!rawEntered || !Number.isFinite(entered) || entered <= 0) return null;

  const conversion = item.packageConversion && typeof item.packageConversion === 'object'
    ? item.packageConversion as DraftRecord
    : null;
  if (conversion) {
    const ratio = Number(conversion.ratio);
    const targetUnit = asText(conversion.targetUnit);
    if (Number.isFinite(ratio) && ratio > 0 && targetUnit) {
      return { quantity: entered * ratio, unit: targetUnit };
    }
  }
  return {
    quantity: entered,
    unit: asText(item.enteredUnit) || asText(item.actualUnit) || asText(item.plannedUnit),
  };
}

function quantitySummary(item: DraftRecord) {
  if (asText(item.action) === 'complete_without_inventory') return '仅完成购物项，不登记库存';
  if (asText(item.targetKind) === 'presence_ingredient') return '完成购物项并更新为有库存';
  const canonical = canonicalActual(item);
  if (!canonical) return quantityValue(item).trim() ? '实际数量无效' : '待补实际购买数量';
  const actual = canonical.quantity;
  const actualText = displayQuantity(actual);
  const unit = canonical.unit;
  const planned = Number(item.plannedQuantity);
  const plannedUnit = asText(item.plannedUnit);
  if (Number.isFinite(planned) && plannedUnit && unit && unit !== plannedUnit) {
    if (asText(item.targetKind) === 'exact_ingredient') {
      return `实际入库 ${actualText} ${unit}；计划 ${displayQuantity(planned)} ${plannedUnit}，提交时按食材单位换算`;
    }
    return `实际入库 ${actualText} ${unit}；计划单位为 ${plannedUnit}，提交前需确认单位`;
  }
  if (Number.isFinite(planned) && actual < planned) {
    return `入库 ${actualText} ${unit}，保留 ${displayQuantity(planned - actual)} ${plannedUnit || unit}待买`;
  }
  if (Number.isFinite(planned) && actual > planned) {
    return `实际入库 ${actualText} ${unit}，超过计划 ${displayQuantity(planned)} ${plannedUnit || unit}`;
  }
  return `完成并入库 ${actualText} ${unit}`;
}

function matchLabel(value: string) {
  if (value === 'suggested') return '建议匹配';
  if (value === 'ambiguous') return '需要选择';
  return '已确认匹配';
}

function candidateAction(value: string) {
  if (value === 'ingredient_profile') return '建议创建食材档案';
  if (value === 'food_profile') return '建议创建食物资料';
  if (value === 'inventory_intake') return '建议后续单独入库';
  return '建议先选择真实目标';
}

export function validateAiShoppingIntakeDraftForSubmit(draft: DraftRecord) {
  const items = asDraftArray(draft.items);
  if (items.length === 0) return '本次没有可处理的待买项';
  for (const item of items) {
    const title = asText(item.title, '该购物项');
    if (asText(item.matchLevel) === 'ambiguous') return `「${title}」仍有多个候选，请先选择真实目标`;
    if (isQuantityTarget(item)) {
      const quantity = Number(quantityValue(item));
      if (!Number.isFinite(quantity) || quantity <= 0) return `请填写「${title}」的实际购买数量`;
      if (!asText(item.enteredUnit)) return `请填写「${title}」的实际购买单位`;
    }
    if (asText(item.action) === 'stock_and_fulfill' && !asText(item.storageLocation)) {
      return `请填写「${title}」的存放位置`;
    }
    if (item.packageConversion && typeof item.packageConversion === 'object') {
      const conversion = item.packageConversion as DraftRecord;
      const ratio = Number(conversion.ratio);
      if (!Number.isFinite(ratio) || ratio <= 0 || !asText(conversion.targetUnit) || !asText(conversion.evidence)) {
        return `请补全「${title}」的包装换算倍率、目标单位和证据`;
      }
    }
  }
  return '';
}

export function AiShoppingIntakeApproval({ draft, readonly, onChange }: AiShoppingIntakeApprovalProps) {
  const items = asDraftArray(draft.items);
  const unmatched = asDraftArray(draft.unmatchedCandidates);
  const attentionIds = useMemo(
    () => new Set(items.filter(needsAttention).map(itemId)),
    [items],
  );
  const [expandedIds, setExpandedIds] = useState<Set<string>>(() => new Set(attentionIds));

  const updateItem = (id: string, patch: DraftRecord) => {
    onChange({
      ...draft,
      items: items.map((item) => (itemId(item) === id ? { ...item, ...patch } : item)),
    });
  };

  const updateConversion = (id: string, item: DraftRecord, patch: DraftRecord) => {
    const current = item.packageConversion && typeof item.packageConversion === 'object'
      ? item.packageConversion as DraftRecord
      : {};
    updateItem(id, { packageConversion: { ...current, ...patch } });
  };

  return (
    <section className="ai-shopping-intake-editor" aria-label="采购完成与入库">
      <header className="ai-shopping-intake-overview">
        <div>
          <span>采购日期 {asText(draft.purchaseDate, '待确认')}</span>
          <strong>{items.length} 项待处理</strong>
        </div>
        <p>{attentionIds.size > 0 ? `${attentionIds.size} 项需要补充或复核` : '信息完整，可统一确认'}</p>
      </header>

      <div className="ai-shopping-intake-list">
        {items.map((item) => {
          const id = itemId(item);
          const title = asText(item.title, '未命名购物项');
          const expanded = expandedIds.has(id);
          const matchLevel = asText(item.matchLevel, 'confirmed');
          const conversion = item.packageConversion && typeof item.packageConversion === 'object'
            ? item.packageConversion as DraftRecord
            : null;
          return (
            <article className={`ai-shopping-intake-row${needsAttention(item) ? ' needs-attention' : ''}`} key={id}>
              <button
                type="button"
                className="ai-shopping-intake-row-toggle"
                aria-expanded={expanded}
                onClick={() => setExpandedIds((current) => {
                  const next = new Set(current);
                  if (next.has(id)) next.delete(id);
                  else next.add(id);
                  return next;
                })}
              >
                <span className="ai-shopping-intake-row-copy">
                  <strong>{title}</strong>
                  <small>{quantitySummary(item)}</small>
                </span>
                <span className={`ai-shopping-intake-match match-${matchLevel}`}>{matchLabel(matchLevel)}</span>
                <span className="ai-shopping-intake-chevron" aria-hidden="true">⌄</span>
              </button>

              {expanded ? (
                <div className="ai-shopping-intake-row-body">
                  <p className="ai-shopping-intake-match-reason">{asText(item.matchReason)}</p>
                  <label className="ai-shopping-intake-field">
                    <span>本行处理方式</span>
                    <select
                      className="text-input"
                      value={asText(item.action, 'stock_and_fulfill')}
                      disabled={readonly}
                      onChange={(event) => updateItem(id, { action: event.target.value })}
                    >
                      <option value="stock_and_fulfill">完成并登记库存</option>
                      <option value="complete_without_inventory">仅完成购物项</option>
                    </select>
                  </label>

                  {isQuantityTarget(item) ? (
                    <div className="ai-shopping-intake-quantity-grid">
                      <label className="ai-shopping-intake-field">
                        <span>实际购买数量</span>
                        <input
                          className="text-input"
                          type="number"
                          min="0"
                          step="any"
                          aria-label={`${title}实际购买数量`}
                          value={quantityValue(item)}
                          disabled={readonly}
                          onChange={(event) => updateItem(id, { enteredQuantity: event.target.value })}
                        />
                      </label>
                      <label className="ai-shopping-intake-field">
                        <span>单位</span>
                        <input
                          className="text-input"
                          aria-label={`${title}实际购买单位`}
                          value={asText(item.enteredUnit)}
                          disabled={readonly}
                          onChange={(event) => updateItem(id, { enteredUnit: event.target.value })}
                        />
                      </label>
                    </div>
                  ) : null}

                  {asText(item.targetKind) === 'presence_ingredient' && asText(item.action) === 'stock_and_fulfill' ? (
                    <label className="ai-shopping-intake-field">
                      <span>买到后的库存状态</span>
                      <select
                        className="text-input"
                        value={asText(item.resultingAvailabilityLevel, 'sufficient')}
                        disabled={readonly}
                        onChange={(event) => updateItem(id, { resultingAvailabilityLevel: event.target.value })}
                      >
                        <option value="sufficient">充足</option>
                        <option value="present_unknown">还在，数量不确定</option>
                        <option value="low">少量</option>
                      </select>
                    </label>
                  ) : null}

                  {conversion ? (
                    <section className="ai-shopping-intake-conversion" aria-label={`${title}包装换算`}>
                      <strong>一次性包装换算</strong>
                      <div className="ai-shopping-intake-quantity-grid">
                        <label className="ai-shopping-intake-field">
                          <span>每份换算倍率</span>
                          <input className="text-input" type="number" min="0" step="any" value={asText(conversion.ratio)} disabled={readonly} onChange={(event) => updateConversion(id, item, { ratio: event.target.value })} />
                        </label>
                        <label className="ai-shopping-intake-field">
                          <span>入库目标单位</span>
                          <input className="text-input" value={asText(conversion.targetUnit)} disabled={readonly} onChange={(event) => updateConversion(id, item, { targetUnit: event.target.value })} />
                        </label>
                      </div>
                      <label className="ai-shopping-intake-field">
                        <span>换算证据</span>
                        <input className="text-input" value={asText(conversion.evidence)} disabled={readonly} onChange={(event) => updateConversion(id, item, { evidence: event.target.value })} />
                      </label>
                    </section>
                  ) : null}

                  {asText(item.action) === 'stock_and_fulfill' ? (
                    <details className="ai-shopping-intake-advanced" open={!asText(item.storageLocation)}>
                      <summary>保存与其他信息</summary>
                      <div className="ai-shopping-intake-advanced-grid">
                        <label className="ai-shopping-intake-field">
                          <span>存放位置</span>
                          <input className="text-input" value={asText(item.storageLocation)} disabled={readonly} onChange={(event) => updateItem(id, { storageLocation: event.target.value })} />
                        </label>
                        <label className="ai-shopping-intake-field">
                          <span>到期日</span>
                          <input className="text-input" type="date" value={asText(item.expiryDate)} disabled={readonly} onChange={(event) => updateItem(id, { expiryDate: event.target.value || null })} />
                        </label>
                        {asText(item.targetKind) !== 'food' ? (
                          <label className="ai-shopping-intake-field">
                            <span>库存状态</span>
                            <select className="text-input" value={asText(item.inventoryStatus, 'fresh')} disabled={readonly} onChange={(event) => updateItem(id, { inventoryStatus: event.target.value })}>
                              <option value="fresh">新鲜</option>
                              <option value="opened">已开封</option>
                              <option value="frozen">冷冻</option>
                              <option value="expiring">临期</option>
                            </select>
                          </label>
                        ) : null}
                        {asText(item.targetKind) !== 'food' ? (
                          <label className="ai-shopping-intake-field ai-shopping-intake-notes">
                            <span>备注</span>
                            <textarea className="text-input" rows={2} value={asText(item.notes)} disabled={readonly} onChange={(event) => updateItem(id, { notes: event.target.value })} />
                          </label>
                        ) : null}
                      </div>
                    </details>
                  ) : null}
                </div>
              ) : null}
            </article>
          );
        })}
      </div>

      {unmatched.length > 0 ? (
        <aside className="ai-shopping-intake-unmatched">
          <div>
            <strong>额外购买候选</strong>
            <span>不随本次提交</span>
          </div>
          <ul>
            {unmatched.map((candidate, index) => (
              <li key={asText(candidate.clientKey, `candidate-${index}`)}>
                <strong>{asText(candidate.label, '未命名商品')}</strong>
                <span>{candidateAction(asText(candidate.recommendationType))}</span>
                <p>{asText(candidate.recommendation)}</p>
              </li>
            ))}
          </ul>
        </aside>
      ) : null}

      <footer className="ai-shopping-intake-submit-summary">
        <strong>本次统一提交</strong>
        <span>{items.filter((item) => asText(item.action) === 'stock_and_fulfill').length} 项入库 · {items.filter((item) => asText(item.action) === 'complete_without_inventory').length} 项仅完成</span>
      </footer>
    </section>
  );
}
