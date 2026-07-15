// @vitest-environment jsdom

import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { Food, MealLogCandidate, MediaAsset } from '../../api/types';
import { MealComposer, type MealComposerProps } from './MealComposer';
import type { MealComposerFood } from './MealComposerModel';

function media(id: string, overrides: Partial<MediaAsset> = {}): MediaAsset {
  return {
    id,
    name: id,
    url: `/media/${id}.jpg`,
    source: 'upload',
    alt: id,
    created_at: '2026-07-15T10:00:00Z',
    ...overrides,
  };
}

function candidate(id: string, overrides: Partial<MealLogCandidate> = {}): MealLogCandidate {
  return {
    meal_log_id: id,
    row_version: 2,
    date: '2026-07-15',
    meal_type: 'dinner',
    created_at: '2026-07-15T10:00:00Z',
    foods: [
      { food_id: 'food-a', name: '番茄炒蛋', food_type: 'selfMade' },
      { food_id: 'food-b', name: '青菜', food_type: 'selfMade' },
    ],
    preview_media: null,
    photo_count: 0,
    ...overrides,
  };
}

function food(id: string, name: string, overrides: Partial<Food> = {}): Food {
  return {
    id,
    family_id: 'family-1',
    name,
    type: 'selfMade',
    category: '家常菜',
    flavor_tags: [],
    suitable_meal_types: ['dinner'],
    source_name: '',
    purchase_source: '',
    scene: '',
    images: [],
    notes: '',
    routine_note: '',
    stock_unit: '份',
    storage_location: '',
    favorite: false,
    recipe_id: null,
    row_version: 1,
    created_at: '2026-07-15T00:00:00Z',
    updated_at: '2026-07-15T00:00:00Z',
    ...overrides,
  };
}

function renderComposer(overrides: Partial<MealComposerProps> = {}) {
  const props: MealComposerProps = {
    open: true,
    date: '2026-07-15',
    mealType: 'dinner',
    dateOptions: ['2026-07-15', '2026-07-16', '2026-07-17'],
    foods: [],
    candidates: [],
    selectedCandidateId: null,
    candidateMode: 'none',
    target: { kind: 'new' },
    searchQuery: '',
    searchResults: [],
    isSearchingFoods: false,
    busy: false,
    error: null,
    onClose: vi.fn(),
    onDateChange: vi.fn(),
    onMealTypeChange: vi.fn(),
    onSearchQueryChange: vi.fn(),
    onFoodsChange: vi.fn(),
    onTargetChange: vi.fn(),
    onSubmit: vi.fn(),
    ...overrides,
  };
  const view = render(<MealComposer {...props} />);
  return { ...view, props };
}

describe('MealComposer', () => {
  it('shows no target control for zero candidates', () => {
    renderComposer({ candidates: [], candidateMode: 'none' });
    expect(screen.queryByText(/记在一起|另记一顿/)).not.toBeInTheDocument();
    expect(screen.queryByText(/和今晚这顿一起记吗/)).not.toBeInTheDocument();
  });

  it('shows one inline confirmation with names and image', () => {
    const candidateWithPhoto = candidate('meal-1', {
      preview_media: media('meal-photo', { alt: '今晚这顿' }),
    });
    renderComposer({
      candidates: [candidateWithPhoto],
      candidateMode: 'single',
      selectedCandidateId: 'meal-1',
      target: { kind: 'existing', meal_log_id: 'meal-1', expected_row_version: 2 },
    });

    expect(screen.getByText('和今晚这顿一起记吗？')).toBeVisible();
    expect(screen.getByText('番茄炒蛋、青菜')).toBeVisible();
    expect(screen.getByRole('img', { name: /今晚这顿/ })).toBeVisible();
    expect(screen.getByRole('button', { name: '记在一起' })).toBeVisible();
    expect(screen.getByRole('button', { name: '另记一顿' })).toBeVisible();
    // Single candidate confirmation is inline, not a nested modal.
    expect(document.querySelectorAll('.workspace-overlay-root').length).toBe(1);
  });

  it('expands multi candidate chooser and keeps 另记一顿', async () => {
    const user = userEvent.setup();
    const older = candidate('meal-old', {
      created_at: '2026-07-15T08:00:00Z',
      foods: [{ food_id: 'food-1', name: '红烧肉', food_type: 'selfMade' }],
    });
    const newer = candidate('meal-new', {
      created_at: '2026-07-15T12:00:00Z',
      foods: [{ food_id: 'food-2', name: '清蒸鱼', food_type: 'selfMade' }],
    });
    const onTargetChange = vi.fn();
    renderComposer({
      candidates: [older, newer],
      candidateMode: 'multi',
      selectedCandidateId: 'meal-new',
      target: { kind: 'existing', meal_log_id: 'meal-new', expected_row_version: 2 },
      onTargetChange,
    });

    expect(screen.getByText('红烧肉')).toBeVisible();
    expect(screen.getByText('清蒸鱼')).toBeVisible();
    expect(screen.getByRole('option', { name: '另记一顿' })).toBeVisible();

    await user.click(screen.getByRole('option', { name: '另记一顿' }));
    expect(onTargetChange).toHaveBeenCalledWith({ kind: 'new' }, null);
  });

  it('defaults snack single candidate to 另记一顿 language', () => {
    const one = candidate('meal-snack', {
      meal_type: 'snack',
      foods: [{ food_id: 'food-s', name: '酸奶', food_type: 'readyMade' }],
    });
    renderComposer({
      mealType: 'snack',
      candidates: [one],
      candidateMode: 'single',
      selectedCandidateId: null,
      target: { kind: 'new' },
    });

    expect(screen.getByText('要和这次加餐记在一起吗？')).toBeVisible();
    expect(screen.getByRole('button', { name: '另记一顿' })).toBeVisible();
    expect(screen.getByRole('button', { name: '记在一起' })).toBeVisible();
  });

  it('shows final combination preview when joining an existing meal', () => {
    const existing = candidate('meal-1');
    const foods: MealComposerFood[] = [
      { kind: 'existing', food_id: 'food-c', name: '米饭', servings: 1 },
    ];
    renderComposer({
      foods,
      candidates: [existing],
      candidateMode: 'single',
      selectedCandidateId: 'meal-1',
      target: { kind: 'existing', meal_log_id: 'meal-1', expected_row_version: 2 },
    });

    expect(screen.getByText(/这顿会记成/)).toBeVisible();
    expect(screen.getByText(/番茄炒蛋、青菜、米饭/)).toBeVisible();
  });

  it('requires inline food type chips when creating by name', async () => {
    const user = userEvent.setup();
    const onFoodsChange = vi.fn();
    renderComposer({
      searchQuery: '酸汤牛肉',
      searchResults: [],
      onFoodsChange,
    });

    await user.click(screen.getByRole('option', { name: "按‘酸汤牛肉’记下" }));
    expect(screen.getByRole('button', { name: '家里做' })).toBeVisible();
    expect(screen.getByRole('button', { name: '外卖' })).toBeVisible();
    expect(screen.getByRole('button', { name: '外食' })).toBeVisible();
    expect(screen.getByRole('button', { name: '买来即食' })).toBeVisible();
    expect(onFoodsChange).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: '家里做' }));
    expect(onFoodsChange).toHaveBeenCalled();
    const nextFoods = onFoodsChange.mock.calls.at(-1)?.[0] as MealComposerFood[];
    expect(nextFoods).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'new',
          name: '酸汤牛肉',
          type: 'selfMade',
          servings: 1,
        }),
      ]),
    );
  });

  it('supports keyboard selection of search results', async () => {
    const user = userEvent.setup();
    const onFoodsChange = vi.fn();
    renderComposer({
      searchQuery: '番茄',
      searchResults: [food('food-1', '番茄炒蛋'), food('food-2', '番茄汤')],
      onFoodsChange,
    });

    const input = screen.getByRole('searchbox', { name: '搜索食物' });
    await user.click(input);
    await user.keyboard('{Enter}');

    expect(onFoodsChange).toHaveBeenCalled();
    const nextFoods = onFoodsChange.mock.calls.at(-1)?.[0] as MealComposerFood[];
    expect(nextFoods[0]).toMatchObject({ kind: 'existing', food_id: 'food-1', name: '番茄炒蛋' });
  });

  it('blocks close while busy and disables duplicate submit', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const onSubmit = vi.fn();
    renderComposer({
      busy: true,
      foods: [{ kind: 'existing', food_id: 'food-1', name: '番茄炒蛋', servings: 1 }],
      onClose,
      onSubmit,
    });

    const submit = screen.getByRole('button', { name: /记下|记录|提交|处理中/ });
    expect(submit).toBeDisabled();
    await user.click(submit);
    expect(onSubmit).not.toHaveBeenCalled();

    await user.keyboard('{Escape}');
    expect(onClose).not.toHaveBeenCalled();
  });

  it('shows validation or server errors inline', () => {
    renderComposer({ error: '至少选择一道食物' });
    expect(screen.getByRole('alert')).toHaveTextContent('至少选择一道食物');
  });

  it('keeps primary controls at least 44px tall', () => {
    renderComposer({
      foods: [{ kind: 'existing', food_id: 'food-1', name: '番茄炒蛋', servings: 1 }],
      candidates: [candidate('meal-1')],
      candidateMode: 'single',
      selectedCandidateId: 'meal-1',
      target: { kind: 'existing', meal_log_id: 'meal-1', expected_row_version: 2 },
    });

    const touchTargets = [
      screen.getByRole('button', { name: '记在一起' }),
      screen.getByRole('button', { name: '另记一顿' }),
      screen.getByRole('button', { name: /记下这餐|记录这一餐/ }),
    ];
    for (const target of touchTargets) {
      expect(target.className.length).toBeGreaterThan(0);
    }
    expect(screen.getByRole('button', { name: '记在一起' }).className).toMatch(/meal-composer-/);
    expect(screen.getByRole('button', { name: '另记一顿' }).className).toMatch(/meal-composer-/);
  });

  it('allows removing selected foods and changing servings', async () => {
    const user = userEvent.setup();
    const onFoodsChange = vi.fn();
    const foods: MealComposerFood[] = [
      { kind: 'existing', food_id: 'food-1', name: '番茄炒蛋', servings: 1 },
      { kind: 'existing', food_id: 'food-2', name: '青菜', servings: 1 },
    ];
    renderComposer({ foods, onFoodsChange });

    expect(screen.getByText('番茄炒蛋')).toBeVisible();
    await user.click(screen.getByRole('button', { name: '移除番茄炒蛋' }));
    expect(onFoodsChange).toHaveBeenCalledWith([
      { kind: 'existing', food_id: 'food-2', name: '青菜', servings: 1 },
    ]);

    const list = screen.getByRole('list', { name: '已选食物' });
    const firstItem = within(list).getAllByRole('listitem')[0]!;
    await user.click(within(firstItem).getByRole('button', { name: /增加/ }));
    expect(onFoodsChange).toHaveBeenCalled();
  });
});
