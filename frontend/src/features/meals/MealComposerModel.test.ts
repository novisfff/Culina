import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MediaAsset, MealLogCandidate } from '../../api/types';
import {
  MealComposerValidationError,
  buildRecordMealPayload,
  createMealBusinessDate,
  createMealRecordDateOptions,
  deriveCandidatePresentation,
  mealDateStripLabel,
  mealTypeFromBusinessInstant,
  reconcilePlannedMealFoods,
  selectMealPreviewMedia,
  canSubmitWithCandidateResolution,
  type MealComposerFood,
} from './MealComposerModel';

function media(id: string, overrides: Partial<MediaAsset> = {}): MediaAsset {
  return {
    id,
    name: id,
    url: `/media/${id}.jpg`,
    source: 'upload',
    alt: id,
    created_at: '2026-07-14T10:00:00Z',
    ...overrides,
  };
}

function candidate(id: string, overrides: Partial<MealLogCandidate> = {}): MealLogCandidate {
  return {
    meal_log_id: id,
    row_version: 3,
    date: '2026-07-14',
    meal_type: 'dinner',
    created_at: '2026-07-14T10:00:00Z',
    foods: [{ food_id: 'food-1', name: '番茄炒蛋', food_type: 'selfMade' }],
    preview_media: null,
    photo_count: 0,
    ...overrides,
  };
}

const existingFood: MealComposerFood = {
  kind: 'existing',
  food_id: 'food-1',
  name: '番茄炒蛋',
  servings: 1,
};

const newFood: MealComposerFood = {
  kind: 'new',
  client_food_id: 'tmp-1',
  name: ' residual name ',
  type: 'selfMade',
  servings: 2,
};

afterEach(() => {
  vi.useRealTimers();
});

describe('deriveCandidatePresentation', () => {
  it('defaults to a new meal when there are no candidates', () => {
    expect(deriveCandidatePresentation([], 'dinner')).toEqual({
      mode: 'none',
      target: { kind: 'new' },
      selectedCandidateId: null,
      defaultsVisible: true,
      defaultsEditable: true,
    });
  });

  it('defaults a single non-snack candidate to existing', () => {
    const one = candidate('meal-1');
    expect(deriveCandidatePresentation([one], 'dinner')).toMatchObject({
      mode: 'single',
      target: { kind: 'existing', meal_log_id: one.meal_log_id, expected_row_version: one.row_version },
      selectedCandidateId: one.meal_log_id,
      defaultsVisible: true,
      defaultsEditable: true,
    });
  });

  it('defaults a single snack candidate to a new meal', () => {
    const one = candidate('meal-1', { meal_type: 'snack' });
    expect(deriveCandidatePresentation([one], 'snack')).toMatchObject({
      mode: 'single',
      target: { kind: 'new' },
      selectedCandidateId: null,
      defaultsVisible: true,
      defaultsEditable: true,
    });
  });

  it('defaults multi non-snack candidates to the newest existing meal', () => {
    const older = candidate('meal-old', { created_at: '2026-07-14T09:00:00Z', row_version: 1 });
    const newer = candidate('meal-new', { created_at: '2026-07-14T12:00:00Z', row_version: 4 });
    expect(deriveCandidatePresentation([older, newer], 'lunch')).toMatchObject({
      mode: 'multi',
      target: { kind: 'existing', meal_log_id: newer.meal_log_id, expected_row_version: 4 },
      selectedCandidateId: newer.meal_log_id,
      defaultsVisible: true,
      defaultsEditable: true,
    });
  });

  it('defaults multi snack candidates to a new meal while remaining multi', () => {
    const first = candidate('meal-a', { meal_type: 'snack', created_at: '2026-07-14T09:00:00Z' });
    const second = candidate('meal-b', { meal_type: 'snack', created_at: '2026-07-14T12:00:00Z' });
    expect(deriveCandidatePresentation([first, second], 'snack')).toMatchObject({
      mode: 'multi',
      target: { kind: 'new' },
      selectedCandidateId: null,
      defaultsVisible: true,
      defaultsEditable: true,
    });
  });
});

describe('buildRecordMealPayload', () => {
  it('maps existing and new foods into payload order with trimmed new names', () => {
    const payload = buildRecordMealPayload({
      clientRequestId: 'req-1',
      date: '2026-07-14',
      mealType: 'dinner',
      target: { kind: 'new' },
      foods: [existingFood, newFood],
    });

    expect(payload).toEqual({
      client_request_id: 'req-1',
      date: '2026-07-14',
      meal_type: 'dinner',
      target: { kind: 'new' },
      new_foods: [{ client_food_id: 'tmp-1', name: 'residual name', type: 'selfMade' }],
      entries: [
        { food_id: 'food-1', servings: 1 },
        { client_food_id: 'tmp-1', servings: 2 },
      ],
    });
  });

  it('includes expected row version for existing targets', () => {
    const payload = buildRecordMealPayload({
      clientRequestId: 'req-2',
      date: '2026-07-14',
      mealType: 'breakfast',
      target: { kind: 'existing', meal_log_id: 'meal-9', expected_row_version: 7 },
      foods: [existingFood],
    });

    expect(payload.target).toEqual({
      kind: 'existing',
      meal_log_id: 'meal-9',
      expected_row_version: 7,
    });
    expect(payload.new_foods).toEqual([]);
  });

  it('includes unique completion references from selected planned foods', () => {
    const payload = buildRecordMealPayload({
      clientRequestId: 'req-plan',
      date: '2026-07-14',
      mealType: 'dinner',
      target: { kind: 'new' },
      foods: [
        {
          ...existingFood,
          planItems: [
            { id: 'plan-1', baseUpdatedAt: '2026-07-14T08:00:00Z' },
            { id: 'plan-2', baseUpdatedAt: '2026-07-14T09:00:00Z' },
            { id: 'plan-1', baseUpdatedAt: '2026-07-14T08:00:00Z' },
          ],
        },
      ],
    });

    expect(payload.plan_item_completions).toEqual([
      {
        food_plan_item_id: 'plan-1',
        food_plan_item_base_updated_at: '2026-07-14T08:00:00Z',
      },
      {
        food_plan_item_id: 'plan-2',
        food_plan_item_base_updated_at: '2026-07-14T09:00:00Z',
      },
    ]);
  });

  it('rejects empty food lists before network calls', () => {
    expect(() =>
      buildRecordMealPayload({
        clientRequestId: 'req-3',
        date: '2026-07-14',
        mealType: 'dinner',
        target: { kind: 'new' },
        foods: [],
      }),
    ).toThrow(MealComposerValidationError);
  });

  it('rejects duplicate final foods by food_id and client_food_id', () => {
    expect(() =>
      buildRecordMealPayload({
        clientRequestId: 'req-4',
        date: '2026-07-14',
        mealType: 'dinner',
        target: { kind: 'new' },
        foods: [existingFood, { ...existingFood, servings: 2 }],
      }),
    ).toThrow(MealComposerValidationError);

    expect(() =>
      buildRecordMealPayload({
        clientRequestId: 'req-5',
        date: '2026-07-14',
        mealType: 'dinner',
        target: { kind: 'new' },
        foods: [newFood, { ...newFood, name: '另一个' }],
      }),
    ).toThrow(MealComposerValidationError);
  });

  it('rejects blank, overlong, and disallowed new food names/types', () => {
    const blank = () =>
      buildRecordMealPayload({
        clientRequestId: 'req-6',
        date: '2026-07-14',
        mealType: 'dinner',
        target: { kind: 'new' },
        foods: [{ ...newFood, name: '   ' }],
      });
    const long = () =>
      buildRecordMealPayload({
        clientRequestId: 'req-7',
        date: '2026-07-14',
        mealType: 'dinner',
        target: { kind: 'new' },
        foods: [{ ...newFood, name: 'a'.repeat(121) }],
      });
    const badType = () =>
      buildRecordMealPayload({
        clientRequestId: 'req-8',
        date: '2026-07-14',
        mealType: 'dinner',
        target: { kind: 'new' },
        foods: [{ ...newFood, type: 'instant' as 'selfMade' }],
      });

    for (const run of [blank, long, badType]) {
      try {
        run();
        expect.unreachable('expected validation error');
      } catch (error) {
        expect(error).toBeInstanceOf(MealComposerValidationError);
        expect((error as MealComposerValidationError).issues.length).toBeGreaterThan(0);
      }
    }

    expect(() =>
      buildRecordMealPayload({
        clientRequestId: 'req-9',
        date: '2026-07-14',
        mealType: 'dinner',
        target: { kind: 'new' },
        foods: [{ ...newFood, name: 'a' }],
      }),
    ).not.toThrow();

    expect(() =>
      buildRecordMealPayload({
        clientRequestId: 'req-10',
        date: '2026-07-14',
        mealType: 'dinner',
        target: { kind: 'new' },
        foods: [{ ...newFood, name: 'a'.repeat(120), type: 'readyMade' }],
      }),
    ).not.toThrow();
  });
});

describe('reconcilePlannedMealFoods', () => {
  it('replaces old automatic plan foods while preserving manual selections', () => {
    const current: MealComposerFood[] = [
      {
        kind: 'existing',
        food_id: 'food-old-plan',
        name: '旧计划菜',
        servings: 1,
        planItems: [{ id: 'plan-old', baseUpdatedAt: '2026-07-14T08:00:00Z' }],
      },
      {
        kind: 'existing',
        food_id: 'food-manual',
        name: '手动添加菜',
        servings: 1.5,
        manuallySelected: true,
      },
    ];

    const result = reconcilePlannedMealFoods(current, [
      {
        id: 'plan-manual',
        foodId: 'food-manual',
        foodName: '手动添加菜',
        baseUpdatedAt: '2026-07-15T08:00:00Z',
      },
      {
        id: 'plan-new',
        foodId: 'food-new-plan',
        foodName: '新计划菜',
        baseUpdatedAt: '2026-07-15T09:00:00Z',
      },
    ]);

    expect(result).toEqual([
      {
        kind: 'existing',
        food_id: 'food-manual',
        name: '手动添加菜',
        servings: 1.5,
        manuallySelected: true,
        planItems: [{ id: 'plan-manual', baseUpdatedAt: '2026-07-15T08:00:00Z' }],
      },
      {
        kind: 'existing',
        food_id: 'food-new-plan',
        name: '新计划菜',
        servings: 1,
        cover: null,
        manuallySelected: false,
        planItems: [{ id: 'plan-new', baseUpdatedAt: '2026-07-15T09:00:00Z' }],
      },
    ]);
  });
});

describe('selectMealPreviewMedia', () => {
  it('prefers MealLog photo, then first Food cover, then null', () => {
    const mealPhoto = media('meal-photo');
    const foodCover = media('food-cover');

    expect(
      selectMealPreviewMedia({
        mealPhotos: [mealPhoto],
        foodCovers: [foodCover],
      }),
    ).toBe(mealPhoto);

    expect(
      selectMealPreviewMedia({
        mealPhotos: [],
        foodCovers: [null, foodCover],
      }),
    ).toBe(foodCover);

    expect(
      selectMealPreviewMedia({
        mealPhotos: [],
        foodCovers: [null, undefined],
      }),
    ).toBeNull();
  });
});

describe('createMealBusinessDate', () => {
  it('uses Asia/Shanghai even when the device zone is behind', () => {
    // 2026-07-14 20:30 in New York is already 2026-07-15 in Shanghai.
    const instant = new Date('2026-07-15T00:30:00.000Z');
    expect(createMealBusinessDate(instant)).toBe('2026-07-15');
  });

  it('uses Asia/Shanghai even when the device zone is ahead', () => {
    // 2026-07-15 00:30 in Tokyo is still 2026-07-14 in Shanghai.
    const instant = new Date('2026-07-14T15:30:00.000Z');
    expect(createMealBusinessDate(instant)).toBe('2026-07-14');
  });
});

describe('meal record date helpers', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('offers past 6 days through today, not future days', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-15T12:00:00+08:00'));
    const options = createMealRecordDateOptions(createMealBusinessDate());
    expect(options).toEqual([
      '2026-07-09',
      '2026-07-10',
      '2026-07-11',
      '2026-07-12',
      '2026-07-13',
      '2026-07-14',
      '2026-07-15',
    ]);
  });

  it('labels yesterday relative to Shanghai business day', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-15T12:00:00+08:00'));
    expect(mealDateStripLabel('2026-07-14')).toBe('昨天');
    expect(mealDateStripLabel('2026-07-15')).toBe('今天');
  });

  it.each([
    ['03:59', '2026-07-14T19:59:00.000Z', 'snack'],
    ['04:00', '2026-07-14T20:00:00.000Z', 'breakfast'],
    ['10:59', '2026-07-15T02:59:00.000Z', 'breakfast'],
    ['11:00', '2026-07-15T03:00:00.000Z', 'lunch'],
    ['14:59', '2026-07-15T06:59:00.000Z', 'lunch'],
    ['15:00', '2026-07-15T07:00:00.000Z', 'snack'],
    ['16:59', '2026-07-15T08:59:00.000Z', 'snack'],
    ['17:00', '2026-07-15T09:00:00.000Z', 'dinner'],
    ['21:59', '2026-07-15T13:59:00.000Z', 'dinner'],
    ['22:00', '2026-07-15T14:00:00.000Z', 'snack'],
  ] as const)('maps Shanghai %s to %s', (_label, instant, expected) => {
    expect(mealTypeFromBusinessInstant(new Date(instant))).toBe(expected);
  });

  it('blocks submit until candidate resolution is ready', () => {
    expect(canSubmitWithCandidateResolution({ status: 'idle' })).toBe(false);
    expect(canSubmitWithCandidateResolution({ status: 'loading' })).toBe(false);
    expect(canSubmitWithCandidateResolution({ status: 'error', message: 'x' })).toBe(false);
    expect(canSubmitWithCandidateResolution({ status: 'ready' })).toBe(true);
  });
});
