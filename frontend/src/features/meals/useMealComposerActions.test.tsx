// @vitest-environment jsdom

import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../api/request';
import type {
  MealLog,
  MealLogCandidate,
  RecordMealResponse,
} from '../../api/types';
import { useMealComposerActions } from './useMealComposerActions';
import { useMealComposerState } from './useMealComposerState';

const now = new Date('2026-07-15T19:00:00+08:00');

function mealLog(overrides: Partial<MealLog> = {}): MealLog {
  return {
    id: 'meal-1',
    family_id: 'family-1',
    date: '2026-07-15',
    meal_type: 'dinner',
    food_entries: [
      {
        id: 'entry-1',
        food_id: 'food-1',
        food_name: '番茄炒蛋',
        servings: 1,
        note: '',
        rating: null,
      },
    ],
    participant_user_ids: ['user-1'],
    notes: '',
    mood: '',
    photos: [],
    deduction_suggestions: [],
    row_version: 2,
    created_at: '2026-07-15T11:00:00.000Z',
    updated_at: '2026-07-15T11:00:00.000Z',
    ...overrides,
  };
}

function recordResponse(overrides: Partial<RecordMealResponse> = {}): RecordMealResponse {
  return {
    meal_log: mealLog(),
    created_foods: [],
    outcome: 'created',
    operation: {
      id: 'op-1',
      status: 'applied',
      revertible_until: '2026-07-15T11:15:00.000Z',
      can_revert: true,
    },
    ...overrides,
  };
}

function candidate(id: string, rowVersion = 1): MealLogCandidate {
  return {
    meal_log_id: id,
    row_version: rowVersion,
    date: '2026-07-15',
    meal_type: 'dinner',
    created_at: '2026-07-15T10:00:00.000Z',
    foods: [{ food_id: 'food-a', name: '已有菜', food_type: 'selfMade' }],
    preview_media: null,
    photo_count: 0,
  };
}

describe('useMealComposerActions', () => {
  it('invalidates, closes composer, then publishes the full record result on success', async () => {
    const events: string[] = [];
    const response = recordResponse();
    const recordMeal = vi.fn(async () => {
      events.push('record');
      return response;
    });
    const invalidateAfterRecord = vi.fn(async () => {
      events.push('invalidate');
    });
    const publishRecordResult = vi.fn(() => {
      events.push('publish');
    });
    const refetchCandidates = vi.fn(async () => ({ data: [] as MealLogCandidate[] }));

    const { result } = renderHook(() => {
      const state = useMealComposerState({
        mode: 'full',
        now,
        createRequestId: () => 'req-stable',
      });
      const actions = useMealComposerActions({
        state,
        candidates: [],
        refetchCandidates,
        recordMeal,
        invalidateAfterRecord,
        publishRecordResult,
      });
      return { state, actions };
    });

    act(() => {
      result.current.state.openComposer();
      result.current.state.setFoods([
        { kind: 'existing', food_id: 'food-1', name: '番茄炒蛋', servings: 1 },
      ]);
    });

    await act(async () => {
      await result.current.actions.submitRecord();
    });

    expect(recordMeal).toHaveBeenCalledWith({
      client_request_id: 'req-stable',
      date: '2026-07-15',
      meal_type: 'dinner',
      target: { kind: 'new' },
      new_foods: [],
      entries: [{ food_id: 'food-1', servings: 1 }],
    });
    expect(events).toEqual(['record', 'invalidate', 'publish']);
    expect(result.current.state.open).toBe(false);
    expect(publishRecordResult).toHaveBeenCalledWith(response);
    expect(invalidateAfterRecord).toHaveBeenCalledWith({ createdFood: false });
  });

  it('replays the same request id on timeout without rotating identity', async () => {
    const recordMeal = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(recordResponse({ outcome: 'replayed' }));
    const invalidateAfterRecord = vi.fn(async () => undefined);
    const publishRecordResult = vi.fn();
    const refetchCandidates = vi.fn(async () => ({ data: [] as MealLogCandidate[] }));

    const { result } = renderHook(() => {
      const state = useMealComposerState({
        mode: 'full',
        now,
        createRequestId: () => 'req-replay',
      });
      const actions = useMealComposerActions({
        state,
        candidates: [],
        refetchCandidates,
        recordMeal,
        invalidateAfterRecord,
        publishRecordResult,
      });
      return { state, actions };
    });

    act(() => {
      result.current.state.openComposer();
      result.current.state.setFoods([
        { kind: 'existing', food_id: 'food-1', name: '番茄炒蛋', servings: 1 },
      ]);
    });

    await act(async () => {
      await result.current.actions.submitRecord();
    });
    expect(result.current.state.error).toBeTruthy();
    expect(result.current.state.recordClientRequestId).toBe('req-replay');

    await act(async () => {
      await result.current.actions.submitRecord();
    });
    expect(recordMeal).toHaveBeenCalledTimes(2);
    expect(recordMeal.mock.calls[0]![0].client_request_id).toBe('req-replay');
    expect(recordMeal.mock.calls[1]![0].client_request_id).toBe('req-replay');
    expect(publishRecordResult).toHaveBeenCalledTimes(1);
  });

  it('keeps food drafts on meal_log_stale, refreshes candidates and requires reconfirm', async () => {
    const refreshed = [candidate('meal-1', 7)];
    const recordMeal = vi.fn(async () => {
      throw new ApiError({
        status: 409,
        detail: '这顿饭刚被家人更新，请刷新后确认',
        path: '/api/meal-logs/record',
        payload: {
          detail: {
            code: 'meal_log_stale',
            message: '这顿饭刚被家人更新，请刷新后确认',
            current: mealLog({ row_version: 7 }),
            recovery_hint: 'refresh_and_review',
          },
        },
      });
    });
    const invalidateAfterRecord = vi.fn(async () => undefined);
    const publishRecordResult = vi.fn();
    const refetchCandidates = vi.fn(async () => ({ data: refreshed }));

    const { result } = renderHook(() => {
      const state = useMealComposerState({
        mode: 'full',
        now,
        createRequestId: () => 'req-stale',
      });
      const actions = useMealComposerActions({
        state,
        candidates: [candidate('meal-1', 1)],
        refetchCandidates,
        recordMeal,
        invalidateAfterRecord,
        publishRecordResult,
      });
      return { state, actions };
    });

    act(() => {
      result.current.state.openComposer();
      result.current.state.setFoods([
        { kind: 'existing', food_id: 'food-1', name: '番茄炒蛋', servings: 1 },
        { kind: 'new', client_food_id: 'tmp-1', name: '酸汤牛肉', type: 'selfMade', servings: 1 },
      ]);
      result.current.state.applyCandidates([candidate('meal-1', 1)]);
    });

    await act(async () => {
      await result.current.actions.submitRecord();
    });

    await waitFor(() => {
      expect(refetchCandidates).toHaveBeenCalled();
    });
    expect(publishRecordResult).not.toHaveBeenCalled();
    expect(invalidateAfterRecord).not.toHaveBeenCalled();
    expect(result.current.state.open).toBe(true);
    expect(result.current.state.foods).toHaveLength(2);
    expect(result.current.state.foods.some((food) => food.kind === 'new')).toBe(true);
    expect(result.current.state.target).toEqual({
      kind: 'existing',
      meal_log_id: 'meal-1',
      expected_row_version: 7,
    });
    expect(result.current.state.requiresTargetReconfirm).toBe(true);
    expect(result.current.state.error).toBe('这顿饭刚被家人更新，请重新确认');
    expect(result.current.state.recordClientRequestId).toBe('req-stale');
  });

  it('invalidates foods when record created new foods', async () => {
    const response = recordResponse({
      created_foods: [
        {
          id: 'food-new',
          family_id: 'family-1',
          name: '酸汤牛肉',
          type: 'selfMade',
          category: '家常菜',
          flavor_tags: [],
          scene_tags: [],
          suitable_meal_types: ['dinner'],
          source_name: '',
          purchase_source: '',
          scene: '',
          images: [],
          notes: '',
          routine_note: '',
          price: null,
          rating: null,
          repurchase: null,
          expiry_date: null,
          stock_quantity: null,
          stock_unit: '',
          storage_location: '',
          favorite: false,
          recipe_id: null,
          row_version: 1,
          created_at: '2026-07-15T11:00:00.000Z',
          updated_at: '2026-07-15T11:00:00.000Z',
        },
      ],
    });
    const recordMeal = vi.fn(async () => response);
    const invalidateAfterRecord = vi.fn(async () => undefined);
    const publishRecordResult = vi.fn();

    const { result } = renderHook(() => {
      const state = useMealComposerState({
        mode: 'full',
        now,
        createRequestId: () => 'req-new-food',
      });
      const actions = useMealComposerActions({
        state,
        candidates: [],
        refetchCandidates: vi.fn(async () => ({ data: [] })),
        recordMeal,
        invalidateAfterRecord,
        publishRecordResult,
      });
      return { state, actions };
    });

    act(() => {
      result.current.state.openComposer();
      result.current.state.setFoods([
        {
          kind: 'new',
          client_food_id: 'tmp-1',
          name: '酸汤牛肉',
          type: 'selfMade',
          servings: 1,
        },
      ]);
    });

    await act(async () => {
      await result.current.actions.submitRecord();
    });

    expect(invalidateAfterRecord).toHaveBeenCalledWith({ createdFood: true });
  });
});
