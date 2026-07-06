import { describe, expect, it } from 'vitest';
import type { FoodPlanItem, MealLog, Member } from '../../api/types';
import { buildMealLogWorkspaceViewModel, filterMealLogs, getMealTone, groupMealsByDate } from './MealLogWorkspaceModel';
import { resolveMealSource } from './MealLogEnrichmentModel';

function makeMealLog(id: string, overrides: Partial<MealLog> = {}): MealLog {
  return {
    id,
    family_id: 'family-1',
    date: '2026-06-02',
    meal_type: 'dinner',
    food_entries: [{ id: `${id}-entry`, food_id: 'food-1', food_name: '番茄炒蛋', servings: 1, note: '', rating: null }],
    participant_user_ids: [],
    notes: '',
    mood: '',
    photos: [],
    deduction_suggestions: [],
    created_at: '2026-06-02T10:30:00Z',
    updated_at: '2026-06-02T10:30:00Z',
    ...overrides,
  };
}

function makePlanItem(mealLogId: string): FoodPlanItem {
  return {
    id: 'plan-1',
    family_id: 'family-1',
    user_id: 'user-1',
    food_id: 'food-1',
    food_name: '番茄炒蛋',
    food_type: 'selfMade',
    recipe_id: null,
    recipe_title: '',
    plan_date: '2026-06-02',
    meal_type: 'dinner',
    note: '',
    status: 'cooked',
    meal_log_id: mealLogId,
    created_at: '2026-06-02T08:00:00Z',
    updated_at: '2026-06-02T08:00:00Z',
  };
}

const member: Member = {
  id: 'user-1',
  username: 'mom',
  display_name: '妈妈',
  avatar_seed: 'seed',
  role: 'Owner',
  status: 'active',
};

describe('MealLogWorkspaceModel', () => {
  it('filters meal logs by search, status, and meal type', () => {
    const doneMeal = makeMealLog('meal-done', { notes: '很香', meal_type: 'lunch' });
    const pendingMeal = makeMealLog('meal-pending', { food_entries: [{ id: 'entry-2', food_id: 'food-2', food_name: '粥', servings: 1, note: '', rating: null }] });
    const mealSources = new Map([
      [doneMeal.id, resolveMealSource(doneMeal, [])],
      [pendingMeal.id, resolveMealSource(pendingMeal, [])],
    ]);

    expect(filterMealLogs({ meals: [doneMeal, pendingMeal], mealSources, searchQuery: '香', statusFilter: 'done', mealFilter: 'lunch' })).toEqual([doneMeal]);
  });

  it('maps meal types to explicit tone class names', () => {
    expect(getMealTone('breakfast')).toBe('meal-tone-breakfast');
    expect(getMealTone('lunch')).toBe('meal-tone-lunch');
    expect(getMealTone('dinner')).toBe('meal-tone-dinner');
    expect(getMealTone('snack')).toBe('meal-tone-snack');
  });

  it('groups meals by date while preserving order', () => {
    const groups = groupMealsByDate([
      makeMealLog('meal-1', { date: '2026-06-02' }),
      makeMealLog('meal-2', { date: '2026-06-02' }),
      makeMealLog('meal-3', { date: '2026-06-01' }),
    ]);

    expect(groups.map((group) => [group.date, group.meals.map((meal) => meal.id)])).toEqual([
      ['2026-06-02', ['meal-1', 'meal-2']],
      ['2026-06-01', ['meal-3']],
    ]);
  });

  it('builds a workspace view model with selected source and participant members', () => {
    const meal = makeMealLog('meal-1', { participant_user_ids: ['user-1'] });
    const model = buildMealLogWorkspaceViewModel({
      recentMeals: [meal],
      foodPlanItems: [makePlanItem(meal.id)],
      members: [member],
      selectedMealId: meal.id,
      searchQuery: '',
      statusFilter: 'all',
      mealFilter: 'all',
    });

    expect(model.selectedSource?.status).toBe('planned');
    expect(model.selectedParticipantMembers.map((item) => item.display_name)).toEqual(['妈妈']);
    expect(model.pendingMeals).toEqual([meal]);
  });
});
