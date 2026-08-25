import type { AiAutoExecutionActionKey } from '../../api/types';

export type AiAutoExecutionActionDefinition = {
  key: AiAutoExecutionActionKey;
  label: string;
  description: string;
};

export const AI_AUTO_EXECUTION_ACTIONS = [
  { key: 'food.set_favorite', label: '收藏状态', description: '只切换现有食物的收藏状态，不修改其他资料。' },
  { key: 'meal_log.rate_food', label: '餐食评分', description: '单次最多 5 项，只修改或取消食物评分。' },
  { key: 'meal_log.simple_create', label: '简单餐食记录', description: '最多 5 个现有食物；不扣库存、不带媒体或计划联动。' },
  { key: 'meal_plan.simple_create', label: '简单餐食计划', description: '最多新增 5 项；不更新状态或联动购物清单。' },
  { key: 'shopping_list.safe_write', label: '购物清单安全操作', description: '仅限量新增、改单项数量/单位/备注，或恢复待买。' },
] as const satisfies readonly AiAutoExecutionActionDefinition[];

export function findAiAutoExecutionAction(key: AiAutoExecutionActionKey) {
  return AI_AUTO_EXECUTION_ACTIONS.find((action) => action.key === key);
}
