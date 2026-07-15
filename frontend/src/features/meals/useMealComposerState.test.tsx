// @vitest-environment jsdom

import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { MealLogCandidate } from '../../api/types';
import { useMealComposerState } from './useMealComposerState';

const now = new Date('2026-07-15T12:00:00+08:00');

function candidate(id: string, overrides: Partial<MealLogCandidate> = {}): MealLogCandidate {
  return {
    meal_log_id: id,
    row_version: 2,
    date: '2026-07-15',
    meal_type: 'lunch',
    created_at: '2026-07-15T04:00:00.000Z',
    foods: [{ food_id: 'food-a', name: '番茄炒蛋', food_type: 'selfMade' }],
    preview_media: null,
    photo_count: 0,
    ...overrides,
  };
}

describe('useMealComposerState', () => {
  it('reuses one request id for failures and creates a new id only after discard', () => {
    let seq = 0;
    const createRequestId = vi.fn(() => `req-${++seq}`);
    const { result } = renderHook(() =>
      useMealComposerState({ mode: 'full', now, createRequestId }),
    );

    const first = result.current.recordClientRequestId;
    expect(first).toBe('req-1');

    act(() => {
      result.current.setError('网络错误');
    });
    expect(result.current.recordClientRequestId).toBe(first);
    expect(result.current.error).toBe('网络错误');

    act(() => {
      result.current.discard();
    });
    expect(result.current.recordClientRequestId).not.toBe(first);
    expect(result.current.recordClientRequestId).toBe('req-2');
    expect(result.current.error).toBeNull();
    expect(result.current.foods).toEqual([]);
  });

  it('starts full mode empty and compact mode with one prefilled existing food', () => {
    const full = renderHook(() => useMealComposerState({ mode: 'full', now }));
    expect(full.result.current.foods).toEqual([]);
    expect(full.result.current.date).toBe('2026-07-15');
    expect(full.result.current.mealType).toBe('lunch');

    const compact = renderHook(() =>
      useMealComposerState({
        mode: 'compact',
        now,
        prefilledFood: {
          food_id: 'food-1',
          name: '青椒肉丝',
          cover: null,
        },
      }),
    );
    expect(compact.result.current.foods).toEqual([
      {
        kind: 'existing',
        food_id: 'food-1',
        name: '青椒肉丝',
        servings: 1,
        cover: null,
      },
    ]);
  });

  it('close preserves draft while discard resets and rotates request identity', () => {
    let seq = 0;
    const createRequestId = vi.fn(() => `req-${++seq}`);
    const { result } = renderHook(() =>
      useMealComposerState({ mode: 'full', now, createRequestId }),
    );

    act(() => {
      result.current.openComposer();
      result.current.setFoods([
        { kind: 'existing', food_id: 'food-1', name: '番茄炒蛋', servings: 1 },
      ]);
      result.current.setDate('2026-07-14');
      result.current.setMealType('dinner');
    });

    const requestId = result.current.recordClientRequestId;
    act(() => {
      result.current.close();
    });
    expect(result.current.open).toBe(false);
    expect(result.current.foods).toHaveLength(1);
    expect(result.current.date).toBe('2026-07-14');
    expect(result.current.mealType).toBe('dinner');
    expect(result.current.recordClientRequestId).toBe(requestId);

    act(() => {
      result.current.openComposer();
    });
    expect(result.current.open).toBe(true);
    expect(result.current.foods[0]?.kind).toBe('existing');

    act(() => {
      result.current.discard();
    });
    expect(result.current.open).toBe(false);
    expect(result.current.foods).toEqual([]);
    expect(result.current.date).toBe('2026-07-15');
    expect(result.current.mealType).toBe('lunch');
    expect(result.current.recordClientRequestId).not.toBe(requestId);
  });

  it('date and meal type changes reset target without clearing foods', () => {
    const { result } = renderHook(() => useMealComposerState({ mode: 'full', now }));

    act(() => {
      result.current.setFoods([
        { kind: 'new', client_food_id: 'tmp-1', name: '酸汤牛肉', type: 'selfMade', servings: 1 },
      ]);
      result.current.applyCandidates([candidate('meal-1')]);
    });
    expect(result.current.target).toEqual({
      kind: 'existing',
      meal_log_id: 'meal-1',
      expected_row_version: 2,
    });

    act(() => {
      result.current.setMealType('dinner');
    });
    expect(result.current.foods).toHaveLength(1);
    expect(result.current.target).toEqual({ kind: 'new' });
    expect(result.current.selectedCandidateId).toBeNull();
    expect(result.current.requiresTargetReconfirm).toBe(false);

    act(() => {
      result.current.applyCandidates([
        candidate('meal-2', { meal_type: 'dinner', row_version: 5 }),
      ]);
    });
    expect(result.current.target).toEqual({
      kind: 'existing',
      meal_log_id: 'meal-2',
      expected_row_version: 5,
    });
    expect(result.current.foods[0]).toMatchObject({ client_food_id: 'tmp-1' });
  });

  it('marks target reconfirmation while keeping food drafts after stale target recovery', () => {
    const { result } = renderHook(() => useMealComposerState({ mode: 'full', now }));

    act(() => {
      result.current.setFoods([
        { kind: 'existing', food_id: 'food-1', name: '番茄炒蛋', servings: 1 },
        { kind: 'new', client_food_id: 'tmp-2', name: '新菜', type: 'takeout', servings: 1 },
      ]);
      result.current.applyCandidates([candidate('meal-1', { row_version: 1 })]);
      result.current.markTargetStaleAndRefresh([
        candidate('meal-1', { row_version: 4 }),
      ]);
    });

    expect(result.current.foods).toHaveLength(2);
    expect(result.current.target).toEqual({
      kind: 'existing',
      meal_log_id: 'meal-1',
      expected_row_version: 4,
    });
    expect(result.current.requiresTargetReconfirm).toBe(true);
    expect(result.current.error).toBe('这顿饭刚被家人更新，请重新确认');
  });
});
