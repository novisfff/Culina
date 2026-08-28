import { useMemo } from 'react';
import type { InventoryReconciliationGroup } from '../../api/types/inventory';
import { convertQuantityToDefaultUnit } from '../../lib/ingredientUnits';
import {
  formatSubmitSummaryLines,
  AVAILABILITY_LEVEL_LABELS,
  reconciliationGroupTargetKey,
  type ExactIngredientIntent,
  type InventoryReconciliationDraft,
  type ReconciliationIntent,
  type ReconciliationSubmitSummary,
} from './inventoryReconciliationModel';

function intentActionLabel(intent: ReconciliationIntent | null): string | null {
  if (!intent) return null;
  if (intent.kind === 'exact_ingredient') return '已加入本次盘点';
  if (intent.kind === 'presence_ingredient') return AVAILABILITY_LEVEL_LABELS[intent.availabilityLevel];
  return '已加入本次盘点';
}

export function InventoryReconciliationSummaryStep(props: {
  summary: ReconciliationSubmitSummary;
  draft: InventoryReconciliationDraft;
  groups: InventoryReconciliationGroup[];
}) {
  const lines = formatSubmitSummaryLines(props.summary);
  const groupByKey = useMemo(
    () => new Map(props.groups.map((group) => [reconciliationGroupTargetKey(group), group])),
    [props.groups],
  );

  function exactIntentSummary(
    group: Extract<InventoryReconciliationGroup, { kind: 'exact_ingredient' }>,
    intent: ExactIngredientIntent,
  ) {
    const unitProfile = {
      default_unit: group.default_unit || group.batches[0]?.unit || '个',
      unit_conversions: group.unit_conversions ?? [],
    };
    const recorded = group.batches.reduce((sum, batch) => {
      const normalized = convertQuantityToDefaultUnit(
        unitProfile,
        Math.max(batch.remaining_quantity, 0),
        batch.unit,
      );
      return sum + (normalized ?? 0);
    }, 0);
    if (intent.action === 'confirm_all') {
      return `数量没问题 · 当前库存 ${Number(recorded.toFixed(2))} ${unitProfile.default_unit}`;
    }
    if (intent.action === 'set_absent') {
      const batchCount = group.batches.filter((batch) => batch.remaining_quantity > 0).length;
      return `清空 ${batchCount} 批库存 · ${Number(recorded.toFixed(2))} → 0 ${unitProfile.default_unit}`;
    }
    const updatesById = new Map(intent.updates.map((update) => [update.inventoryItemId, update]));
    const actualFromBatches = group.batches.reduce((sum, batch) => {
      const update = updatesById.get(batch.inventory_item_id);
      const normalized = convertQuantityToDefaultUnit(
        unitProfile,
        Number(update?.actualRemainingQuantity ?? batch.remaining_quantity),
        batch.unit,
      );
      return sum + (normalized ?? 0);
    }, 0);
    const actualFromCreates = intent.creates.reduce((sum, create) => {
      const normalized = convertQuantityToDefaultUnit(
        unitProfile,
        Number(create.actualRemainingQuantity),
        create.unit,
      );
      return sum + (normalized ?? 0);
    }, 0);
    const clearedCount = intent.updates.filter(
      (update) => Number(update.actualRemainingQuantity) === 0,
    ).length;
    return `${Number(recorded.toFixed(2))} → ${Number((actualFromBatches + actualFromCreates).toFixed(2))} ${unitProfile.default_unit} · ${clearedCount > 0 ? `清空 ${clearedCount} 批库存` : '按库存明细修正'}`;
  }

  return (
    <section className="inventory-maintenance-section" aria-label="确认摘要">
      <div className="inventory-maintenance-section-head">
        <span>确认这些库存调整</span>
        <em>{props.summary.totalTouched} 项</em>
      </div>
      {lines.length === 0 ? (
        <p className="subtle">没有可提交的改动。</p>
      ) : (
        <ul className="inventory-maintenance-summary-list">
          {lines.map((line) => (
            <li key={line.label}>
              <strong>{line.label}</strong>
              <span>{line.count} 项</span>
            </li>
          ))}
        </ul>
      )}
      <ul className="inventory-maintenance-summary-list">
        {props.draft.intents.map((intent) => {
          const key = intentTargetKeySafe(intent);
          const group = groupByKey.get(key);
          const title =
            group == null
              ? key
              : group.kind === 'food'
                ? group.food_name
                : group.ingredient_name;
          return (
            <li key={key} className="inventory-reconciliation-submit-item">
              <div>
                <strong>{title}</strong>
                <span>
                  {group?.kind === 'exact_ingredient' && intent.kind === 'exact_ingredient'
                    ? exactIntentSummary(group, intent)
                    : intentActionLabel(intent)}
                </span>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function intentTargetKeySafe(intent: ReconciliationIntent) {
  if (intent.kind === 'exact_ingredient') return `exact_ingredient:${intent.ingredientId}`;
  if (intent.kind === 'presence_ingredient') return `presence_ingredient:${intent.ingredientId}`;
  return `food:${intent.foodId}`;
}
