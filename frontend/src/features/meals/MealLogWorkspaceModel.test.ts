import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MealLog, Member } from '../../api/types';
import {
  buildMealLogWorkspaceViewModel,
  filterMealLogs,
  getMealMediaCount,
  getMealParticipantCount,
  getMealRatingValue,
  getMealTone,
  getWeekRecordCount,
  groupMealsByDate,
  selectInitialMeal,
} from './MealLogWorkspaceModel';

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
    row_version: 1,
    created_at: '2026-06-02T10:30:00Z',
    updated_at: '2026-06-02T10:30:00Z',
    ...overrides,
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

afterEach(() => {
  vi.useRealTimers();
});

describe('MealLogWorkspaceModel', () => {
  it('filters meal logs by search and meal type without status debt', () => {
    const lunchWithNote = makeMealLog('meal-lunch', { notes: '很香', meal_type: 'lunch' });
    const dinner = makeMealLog('meal-dinner', {
      food_entries: [{ id: 'entry-2', food_id: 'food-2', food_name: '粥', servings: 1, note: '', rating: null }],
    });

    expect(
      filterMealLogs({
        meals: [lunchWithNote, dinner],
        searchQuery: '香',
        mealFilter: 'lunch',
      }),
    ).toEqual([lunchWithNote]);

    expect(
      filterMealLogs({
        meals: [lunchWithNote, dinner],
        searchQuery: '手动补录',
        mealFilter: 'all',
      }),
    ).toEqual([]);
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

  it('counts meals inside the rolling 7-day window using local date keys', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-08T10:00:00+08:00'));

    expect(getWeekRecordCount([
      makeMealLog('meal-1', { date: '2026-06-08' }),
      makeMealLog('meal-2', { date: '2026-06-02' }),
      makeMealLog('meal-3', { date: '2026-06-01' }),
    ])).toBe(2);
  });

  it('builds a workspace view model with participant and present-value counts', () => {
    const meal = makeMealLog('meal-1', {
      participant_user_ids: ['user-1'],
      photos: [
        {
          id: 'photo-1',
          name: 'meal',
          url: '/media/meal.jpg',
          source: 'upload',
          alt: 'meal',
          created_at: '2026-06-02T10:30:00Z',
        },
      ],
      food_entries: [
        { id: 'entry-1', food_id: 'food-1', food_name: '番茄炒蛋', servings: 1, note: '', rating: 4.5 },
      ],
    });
    const model = buildMealLogWorkspaceViewModel({
      recentMeals: [meal],
      members: [member],
      selectedMealId: meal.id,
      searchQuery: '',
      mealFilter: 'all',
    });

    expect(model.selectedParticipantMembers.map((item) => item.display_name)).toEqual(['妈妈']);
    expect(model.selectedParticipantCount).toBe(1);
    expect(model.selectedMediaCount).toBe(1);
    expect(model.selectedRatingValue).toContain('4.5');
    expect(model).not.toHaveProperty('basicMeals');
    expect(model).not.toHaveProperty('enrichedCount');
    expect(model).not.toHaveProperty('selectedSource');
  });

  it('hides zero participant/media/rating counts', () => {
    const meal = makeMealLog('meal-minimal', {
      photos: [],
      notes: '',
      mood: '',
      participant_user_ids: [],
    });
    expect(getMealParticipantCount(meal)).toBeNull();
    expect(getMealMediaCount(meal)).toBeNull();
    expect(getMealRatingValue(meal)).toBeNull();
  });

  it('does not select an older record ahead of a newer valid record', () => {
    const older = makeMealLog('old', { date: '2026-07-11', created_at: '2026-07-11T10:00:00Z' });
    const newer = makeMealLog('new', { date: '2026-07-12', created_at: '2026-07-12T10:00:00Z' });
    expect(selectInitialMeal([older, newer])?.id).toBe('new');
  });

  it('falls back to the newest meal when no selection is provided', () => {
    const older = makeMealLog('old', { date: '2026-07-11', created_at: '2026-07-11T10:00:00Z' });
    const newer = makeMealLog('new', {
      date: '2026-07-12',
      created_at: '2026-07-12T10:00:00Z',
      notes: '有备注',
    });
    const model = buildMealLogWorkspaceViewModel({
      recentMeals: [older, newer],
      members: [],
      selectedMealId: null,
      searchQuery: '',
      mealFilter: 'all',
    });
    expect(model.selectedMeal?.id).toBe('new');
  });
});
