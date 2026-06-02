import { describe, expect, it } from 'vitest';
import type { MealLog } from '../../api/types';
import { buildUpdateMealLogPayload, getMealRatingSummary, hasMeaningfulMealLogInput, isMealLogEnriched } from './MealLogEnrichmentModel';

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
    created_at: '2026-06-02T10:30:00Z',
    updated_at: '2026-06-02T10:30:00Z',
    ...overrides,
  };
}

describe('MealLogEnrichmentModel', () => {
  it('builds an update payload from rating, participant, note, and original photo drafts', () => {
    const payload = buildUpdateMealLogPayload({
      meal: makeMealLog(),
      participants: ['user-1'],
      notes: '  好吃  ',
      entryRatings: { 'entry-1': '4.5', 'entry-2': '' },
      mediaIds: ['media-1'],
    });

    expect(payload).toEqual({
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
