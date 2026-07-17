// @vitest-environment jsdom

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../api/request';
import type { Food, MealLog, MediaAsset, UpdateMealCompositionPayload } from '../../api/types';
import { MealCompositionEditor } from './MealCompositionEditor';

function media(id: string): MediaAsset {
  return {
    id,
    name: id,
    url: `/media/${id}.jpg`,
    source: 'upload',
    alt: id,
    created_at: '2026-07-15T10:00:00Z',
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
        note: '少盐',
        rating: 4,
      },
      {
        id: 'entry-2',
        food_id: 'food-2',
        food_name: '青菜',
        servings: 1,
        note: '',
        rating: null,
      },
    ],
    participant_user_ids: [],
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

describe('MealCompositionEditor', () => {
  it('shows compact food identities and notes without servings or internal ids', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn(async (_payload: UpdateMealCompositionPayload) => mealLog());
    render(
      <MealCompositionEditor
        meal={mealLog()}
        availableFoods={[
          food('food-1', '番茄炒蛋', { images: [media('tomato-egg')] }),
          food('food-2', '青菜'),
        ]}
        busy={false}
        onSubmit={onSubmit}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByText('番茄炒蛋')).toBeVisible();
    expect(screen.getByDisplayValue('少盐')).toBeVisible();
    expect(screen.queryByLabelText('份量')).not.toBeInTheDocument();
    expect(screen.queryByText('菜品 ID')).not.toBeInTheDocument();
    expect(document.querySelectorAll('.meal-composition-editor-media')).toHaveLength(2);

    await user.click(screen.getByRole('button', { name: '移除番茄炒蛋' }));
    expect(screen.getByRole('button', { name: '移除青菜' })).toBeDisabled();
  });

  it('searches existing foods, excludes selected foods, and saves hidden servings safely', async () => {
    const user = userEvent.setup();
    const sourceMeal = mealLog({
      food_entries: [
        { id: 'entry-1', food_id: 'food-1', food_name: '番茄炒蛋', servings: 2.5, note: '少盐', rating: 4 },
      ],
    });
    const onSubmit = vi.fn(async (_payload: UpdateMealCompositionPayload) => sourceMeal);
    render(
      <MealCompositionEditor
        meal={sourceMeal}
        availableFoods={[
          food('food-1', '番茄炒蛋', { images: [media('tomato-egg')] }),
          food('food-rice', '米饭', { images: [media('rice')] }),
        ]}
        onSubmit={onSubmit}
        onClose={vi.fn()}
      />,
    );

    const search = screen.getByRole('searchbox', { name: '搜索并添加食物' });
    await user.type(search, '米');
    const results = screen.getByRole('listbox', { name: '搜索并添加食物结果' });
    expect(results).not.toHaveTextContent('番茄炒蛋');
    await user.click(screen.getByRole('option', { name: /米饭/ }));

    expect(screen.getByText('米饭')).toBeVisible();
    expect(search).toHaveValue('');
    await user.click(screen.getByRole('button', { name: '保存组合' }));

    expect(onSubmit).toHaveBeenCalledWith({
      expected_row_version: 2,
      food_entries: [
        { id: 'entry-1', food_id: 'food-1', servings: 2.5, note: '少盐' },
        { id: null, food_id: 'food-rice', servings: 1, note: '' },
      ],
    });
  });

  it('keeps desktop rows simple and uses one compact row per food on mobile', () => {
    const styles = readFileSync(resolve(__dirname, '../../styles/08-meal-log.css'), 'utf8');
    expect(styles).toMatch(/\.meal-composition-editor-row \{[\s\S]*?grid-template-columns:\s*minmax\(220px, 1fr\) minmax\(180px, 0\.9fr\) 44px/);
    expect(styles).toMatch(/@media \(max-width: 767px\)[\s\S]*?\.meal-composition-editor-row \{[\s\S]*?grid-template-columns:\s*36px minmax\(78px, 1fr\) minmax\(94px, 1fr\) 44px/);
  });

  it('on 409 merges conflicts, updates expected version, and requires explicit resubmit', async () => {
    const user = userEvent.setup();
    const serverMeal = mealLog({
      row_version: 5,
      food_entries: [
        {
          id: 'entry-1',
          food_id: 'food-1',
          food_name: '番茄炒蛋',
          servings: 3,
          note: '服务器备注',
          rating: 4,
        },
        {
          id: 'entry-2',
          food_id: 'food-2',
          food_name: '青菜',
          servings: 1,
          note: '',
          rating: null,
        },
      ],
    });
    const onSubmit = vi
      .fn(async (_payload: UpdateMealCompositionPayload) => mealLog())
      .mockRejectedValueOnce(
        new ApiError({
          status: 409,
          detail: '版本冲突',
          path: '/api/meal-logs/meal-1/composition',
          payload: {
            detail: {
              code: 'meal_log_stale',
              current: serverMeal,
            },
          },
        }),
      )
      .mockResolvedValueOnce(serverMeal);

    render(
      <MealCompositionEditor
        meal={mealLog()}
        busy={false}
        onSubmit={onSubmit}
        onClose={vi.fn()}
      />,
    );

    const notes = screen.getAllByLabelText('备注');
    await user.clear(notes[0]!);
    await user.type(notes[0]!, '本地备注');
    await user.click(screen.getByRole('button', { name: '保存组合' }));

    await waitFor(() => {
      expect(screen.getAllByText(/有冲突，请确认后再保存/).length).toBeGreaterThan(0);
    });
    expect(screen.getByText('备注冲突')).toBeVisible();
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit.mock.calls[0]?.[0]).toMatchObject({ expected_row_version: 2 });

    // Auto-resubmit must not happen; user must click again.
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    await user.click(screen.getByRole('button', { name: '确认并保存' }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(2));
    expect(onSubmit.mock.calls[1]?.[0]).toMatchObject({ expected_row_version: 5 });
  });

  it('timeout refetch treats exact submitted composition as success', async () => {
    const user = userEvent.setup();
    const current = mealLog({
      food_entries: [
        {
          id: 'entry-1',
          food_id: 'food-1',
          food_name: '番茄炒蛋',
          servings: 1,
          note: '更少盐',
          rating: 4,
        },
        {
          id: 'entry-2',
          food_id: 'food-2',
          food_name: '青菜',
          servings: 1,
          note: '',
          rating: null,
        },
      ],
      row_version: 3,
    });
    const onSubmit = vi.fn(async () => {
      throw new ApiError({
        status: 0,
        detail: '网络超时',
        path: '/api/meal-logs/meal-1/composition',
        payload: null,
      });
    });
    const onRefetch = vi.fn(async () => current);
    const onSaved = vi.fn();

    render(
      <MealCompositionEditor
        meal={mealLog()}
        busy={false}
        onSubmit={onSubmit}
        onRefetchMeal={onRefetch}
        onSaved={onSaved}
        onClose={vi.fn()}
      />,
    );

    const notes = screen.getAllByLabelText('备注');
    await user.clear(notes[0]!);
    await user.type(notes[0]!, '更少盐');
    await user.click(screen.getByRole('button', { name: '保存组合' }));

    await waitFor(() => expect(onRefetch).toHaveBeenCalled());
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(current));
    expect(screen.queryByText(/冲突/)).not.toBeInTheDocument();
  });
});
