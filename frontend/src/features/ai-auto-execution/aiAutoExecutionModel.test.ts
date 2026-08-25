import { describe, expect, it } from 'vitest';
import { AI_AUTO_EXECUTION_ACTIONS, findAiAutoExecutionAction } from './aiAutoExecutionModel';

describe('aiAutoExecutionModel', () => {
  it('catalogs the five bounded low-risk actions', () => {
    expect(AI_AUTO_EXECUTION_ACTIONS.map((action) => action.key)).toEqual([
      'food.set_favorite',
      'meal_log.rate_food',
      'meal_log.simple_create',
      'meal_plan.simple_create',
      'shopping_list.safe_write',
    ]);
    expect(findAiAutoExecutionAction('shopping_list.safe_write')?.label).toBe('购物清单安全操作');
  });
});
