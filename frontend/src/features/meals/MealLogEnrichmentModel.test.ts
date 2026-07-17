import { describe, expect, it } from 'vitest';
import type { MealLog } from '../../api/types';
import { buildMealEnrichmentRecordPayload, buildUpdateMealLogPayload, getMealRatingSummary, hasMeaningfulMealLogInput, isMealLogEnriched, mergeMealEntryRatingDraft } from './MealLogEnrichmentModel';

function makeMealLog(overrides: Partial<MealLog> = {}): MealLog {
  return {
    id: 'meal-1',
    family_id: 'family-1',
    date: '2026-06-02',
    meal_type: 'dinner',
    food_entries: [
      { id: 'entry-1', food_id: 'food-1', food_name: '番茄炒蛋', servings: 1, note: '', rating: null },
      { id: 'entry-2', food_id: 'food-2', food_name: '米饭', servings: 1, note: '', rating: null },
    ],
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

describe('MealLogEnrichmentModel', () => {
  it('preserves unsaved ratings while merging newly recorded and removed meal entries', () => {
    const nextMeal = makeMealLog({
      row_version: 2,
      food_entries: [
        { id: 'entry-1', food_id: 'food-1', food_name: '番茄炒蛋', servings: 1, note: '', rating: 3 },
        { id: 'entry-3', food_id: 'food-3', food_name: '凉拌黄瓜', servings: 1, note: '', rating: null },
      ],
    });

    expect(mergeMealEntryRatingDraft({ meal: nextMeal, current: { 'entry-1': '4.5', 'entry-2': '5' } })).toEqual({
      'entry-1': '4.5',
      'entry-3': '',
    });
  });

  it('builds existing-meal append payloads for planned, existing, and new foods', () => {
    const currentMeal = makeMealLog();
    expect(buildMealEnrichmentRecordPayload({
      meal: currentMeal,
      clientRequestId: 'request-plan',
      food: { kind: 'existing', foodId: 'food-rice' },
      planItem: {
        id: 'plan-rice', family_id: 'family-1', user_id: 'user-1', food_id: 'food-rice', food_name: '米饭',
        food_type: 'selfMade', recipe_id: null, recipe_title: '', plan_date: currentMeal.date,
        meal_type: currentMeal.meal_type, note: '', status: 'planned', created_at: '', updated_at: '2026-07-07T01:00:00Z',
      },
    })).toEqual({
      client_request_id: 'request-plan', date: currentMeal.date, meal_type: currentMeal.meal_type,
      target: { kind: 'existing', meal_log_id: currentMeal.id, expected_row_version: currentMeal.row_version },
      entries: [{ food_id: 'food-rice', servings: 1 }],
      plan_item_completions: [{ food_plan_item_id: 'plan-rice', food_plan_item_base_updated_at: '2026-07-07T01:00:00Z' }],
    });
    expect(buildMealEnrichmentRecordPayload({ meal: currentMeal, clientRequestId: 'request-existing', food: { kind: 'existing', foodId: 'food-soup' } }).entries).toEqual([{ food_id: 'food-soup', servings: 1 }]);
    expect(buildMealEnrichmentRecordPayload({ meal: currentMeal, clientRequestId: 'request-new', food: { kind: 'new', clientFoodId: 'tmp-fruit', name: '水果', type: 'readyMade' } })).toMatchObject({
      new_foods: [{ client_food_id: 'tmp-fruit', name: '水果', type: 'readyMade' }],
      entries: [{ client_food_id: 'tmp-fruit', servings: 1 }],
    });
  });

  it('builds an update payload from rating, participant, note, and original photo drafts', () => {
    const payload = buildUpdateMealLogPayload({
      meal: makeMealLog(),
      participants: ['user-1'],
      notes: '  好吃  ',
      entryRatings: { 'entry-1': '4.5', 'entry-2': '' },
      mediaIds: ['media-1'],
    });

    expect(payload).toEqual({
      expected_row_version: 1,
      participant_user_ids: ['user-1'],
      notes: '好吃',
      mood: '4.5 分',
      food_entry_ratings: [
        { id: 'entry-1', rating: 4.5 },
        { id: 'entry-2', rating: null },
      ],
      media_ids: ['media-1'],
    });
  });

  it('detects enriched meals from notes, photos, or dish ratings', () => {
    expect(isMealLogEnriched(makeMealLog())).toBe(false);
    expect(isMealLogEnriched(makeMealLog({ notes: '不错' }))).toBe(true);
    expect(isMealLogEnriched(makeMealLog({ food_entries: [{ id: 'entry-1', food_id: 'food-1', food_name: '饭', servings: 1, note: '', rating: 5 }] }))).toBe(true);
  });

  it('requires meaningful input before saving a draft enrichment', () => {
    const meal = makeMealLog();
    const baseInput = {
      meal,
      participants: [],
      notes: '',
      entryRatings: { 'entry-1': '', 'entry-2': '' },
      mediaIds: [],
    };

    expect(hasMeaningfulMealLogInput(baseInput)).toBe(false);
    expect(hasMeaningfulMealLogInput({ ...baseInput, notes: '下次少油' })).toBe(true);
    expect(hasMeaningfulMealLogInput({ ...baseInput, participants: ['user-1'] })).toBe(true);
    expect(hasMeaningfulMealLogInput({ ...baseInput, entryRatings: { ...baseInput.entryRatings, 'entry-1': '4' } })).toBe(true);
    expect(hasMeaningfulMealLogInput({ ...baseInput, mediaIds: ['media-1'] })).toBe(true);
  });

  it('summarizes multiple dish ratings by average', () => {
    const meal = makeMealLog({
      food_entries: [
        { id: 'entry-1', food_id: 'food-1', food_name: '番茄炒蛋', servings: 1, note: '', rating: 4 },
        { id: 'entry-2', food_id: 'food-2', food_name: '米饭', servings: 1, note: '', rating: 5 },
      ],
    });

    expect(getMealRatingSummary(meal)).toBe('4.5 分 · 2 道菜');
  });
});
