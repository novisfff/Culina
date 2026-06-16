import type {
  AiOperationResultEntity,
  AiInventoryDisplayStatus,
  AiInventoryResultItem,
  AiResultCard,
  AiTodayRecommendationItem,
} from '../../api/types';

export const AI_RESULT_PLACEHOLDER = '/assets/ai-food-ingredient-placeholder.png';

export function inventoryItems(card: AiResultCard): AiInventoryResultItem[] {
  return Array.isArray(card.data.items) ? card.data.items : [];
}

export function recommendationItems(card: AiResultCard): AiTodayRecommendationItem[] {
  return Array.isArray(card.data.recommendations) ? card.data.recommendations : [];
}

export function operationResultEntities(card: AiResultCard): AiOperationResultEntity[] {
  return Array.isArray(card.data.entities) ? card.data.entities : [];
}

export function inventoryStatusText(status: AiInventoryDisplayStatus, daysUntilExpiry?: number | null) {
  if (status === 'expired') return daysUntilExpiry == null ? '已过期' : `已过期 ${Math.abs(daysUntilExpiry)} 天`;
  if (status === 'expiring') return daysUntilExpiry == null ? '临期' : daysUntilExpiry === 0 ? '今天到期' : `${daysUntilExpiry} 天后到期`;
  if (status === 'low_stock') return '库存偏低';
  return '库存充足';
}

export function inventoryExpiryText(item: AiInventoryResultItem) {
  if (!item.expiryDate) return '未记录保质期';
  return `保质期至 ${item.expiryDate}`;
}

export function recommendationMeta(item: AiTodayRecommendationItem) {
  const values = item.entityType === 'recipe'
    ? [
        item.prepMinutes ? `${item.prepMinutes} 分钟` : '',
        item.servings ? `${item.servings} 人份` : '',
        item.difficulty || '',
      ]
    : [item.category || '', item.foodType || ''];
  return values.filter(Boolean).join(' · ');
}

export function evidenceText(item: AiTodayRecommendationItem) {
  return item.evidence
    .map((evidence) => [evidence.label, evidence.detail].filter(Boolean).join(' · '))
    .filter(Boolean)
    .slice(0, 3);
}
