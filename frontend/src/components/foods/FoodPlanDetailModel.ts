import type { Food } from '../../api/types';
import { todayKey } from '../../lib/date';
import { FOOD_TYPE_LABELS, MEAL_TYPE_LABELS, formatDate } from '../../lib/ui';
import {
  formatFoodStockQuantity,
  getRepurchaseLabel,
  isOutsideFood,
  isReadyLikeFood,
  normalizeFoodType,
} from './FoodWorkspaceHelpers';

export type FoodPlanDetailFact = {
  label: string;
  value: string;
};

function describeExpiryFrom(food: Food, today: string): string {
  if (!food.expiry_date) return '未记录';
  const targetTime = new Date(`${food.expiry_date}T00:00:00`).getTime();
  const todayTime = new Date(`${today}T00:00:00`).getTime();
  const days = Math.round((targetTime - todayTime) / 86_400_000);
  if (days < 0) return `已过期 ${Math.abs(days)} 天`;
  if (days === 0) return '今天到期';
  if (days <= 7) return `${days} 天后到期`;
  return formatDate(food.expiry_date);
}

function formatPrice(price: number | null | undefined): string {
  if (price == null) return '未记录';
  return `¥${Number.isInteger(price) ? price : price.toFixed(2)}`;
}

export function getFoodPlanDetailFacts(
  food: Food | null,
  today: string = todayKey(),
): FoodPlanDetailFact[] {
  if (!food) return [];

  const normalizedType = normalizeFoodType(food);
  const category = food.category.trim() || FOOD_TYPE_LABELS[normalizedType];

  if (normalizedType === 'selfMade') {
    return [
      { label: '分类', value: category },
      {
        label: '适合餐次',
        value: food.suitable_meal_types.map((mealType) => MEAL_TYPE_LABELS[mealType]).join('、') || '未设置',
      },
      { label: '关联菜谱', value: food.recipe_id ? '已关联' : '未关联' },
    ];
  }

  if (isOutsideFood(food)) {
    return [
      { label: '分类', value: category },
      {
        label: normalizedType === 'takeout' ? '店铺' : '餐厅',
        value: food.source_name || food.purchase_source || '未记录',
      },
      { label: '价格', value: formatPrice(food.price) },
      { label: '复购', value: getRepurchaseLabel(food) },
    ];
  }

  if (isReadyLikeFood(food)) {
    return [
      { label: '分类', value: category },
      { label: '库存', value: formatFoodStockQuantity(food) },
      { label: '存放', value: food.storage_location || '未记录' },
      { label: '到期', value: describeExpiryFrom(food, today) },
    ];
  }

  return [
    { label: '类型', value: FOOD_TYPE_LABELS[normalizedType] },
    { label: '分类', value: category },
  ];
}
