// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Food, Recipe } from '../../api/types';
import {
  buildActiveCookDescriptorKey,
  buildCookSessionV3Key,
  buildDefaultCookSessionV3,
  saveCookSessionV3,
  type RecipeCookSessionScope,
} from '../../components/recipes/recipeCookSessionStorage';
import { ActiveCookResumeCard } from './ActiveCookResumeCard';

const SCOPE: RecipeCookSessionScope = { userId: 'u1', familyId: 'f1' };
const NOW = Date.parse('2026-07-12T12:00:00.000Z');

function makeRecipe(overrides: Partial<Recipe> = {}): Recipe {
  return {
    id: 'recipe-1',
    family_id: 'f1',
    title: '番茄炒蛋',
    servings: 2,
    prep_minutes: 15,
    difficulty: 'easy',
    ingredient_items: [],
    steps: [{ id: 'step-1', title: '备菜', text: '备菜', icon: 'pan', summary: '', estimated_minutes: null, tip: '', key_points: [] }],
    tips: '',
    images: [],
    cook_logs: [],
    created_at: '2026-07-01T00:00:00.000Z',
    updated_at: '2026-07-01T00:00:00.000Z',
    ...overrides,
  };
}

function makeFood(overrides: Partial<Food> = {}): Food {
  return {
    id: 'food-1',
    family_id: 'f1',
    name: '番茄炒蛋',
    type: 'selfMade',
    category: 'home',
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
    recipe_id: 'recipe-1',
    row_version: 1,
    created_at: '2026-07-01T00:00:00.000Z',
    updated_at: '2026-07-01T00:00:00.000Z',
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.restoreAllMocks();
});

describe('ActiveCookResumeCard', () => {
  it('renders nothing without a current-scope descriptor', () => {
    const { container } = render(
      <ActiveCookResumeCard
        scope={SCOPE}
        recipes={[makeRecipe()]}
        foods={[makeFood()]}
        onResume={vi.fn()}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('shows a compact resume entry and opens cook with resolved entities', async () => {
    const user = userEvent.setup();
    const recipe = makeRecipe();
    const food = makeFood();
    const session = buildDefaultCookSessionV3(recipe, {
      source: 'direct',
      planItemId: null,
      completionRequestId: 'cook-resume-1',
      date: '2026-07-12',
      mealType: 'dinner',
      servings: 2,
    });
    session.currentStepIndex = 0;
    saveCookSessionV3({
      scope: SCOPE,
      recipeId: recipe.id,
      session,
      savedAt: '2026-07-12T11:00:00.000Z',
    });

    const onResume = vi.fn();
    render(
      <ActiveCookResumeCard
        scope={SCOPE}
        recipes={[recipe]}
        foods={[food]}
        onResume={onResume}
        now={NOW}
      />,
    );

    expect(screen.getByTestId('active-cook-resume-card')).toBeInTheDocument();
    expect(screen.getByText(/番茄炒蛋/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '继续做菜' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '放弃' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '继续做菜' }));
    expect(onResume).toHaveBeenCalledWith({
      food,
      recipe,
      launchContext: {
        date: '2026-07-12',
        mealType: 'dinner',
        servings: 2,
        source: { kind: 'direct' },
      },
    });
  });

  it('abandons only the matching current-scope keys', async () => {
    const user = userEvent.setup();
    const recipe = makeRecipe();
    const session = buildDefaultCookSessionV3(recipe, {
      source: 'direct',
      planItemId: null,
      completionRequestId: 'cook-abandon-ui',
    });
    saveCookSessionV3({
      scope: SCOPE,
      recipeId: recipe.id,
      session,
      savedAt: '2026-07-12T11:00:00.000Z',
    });
    const otherKey = buildCookSessionV3Key({ userId: 'u2', familyId: 'f1' }, recipe.id, { kind: 'direct' });
    localStorage.setItem(
      otherKey,
      JSON.stringify({
        version: 3,
        savedAt: '2026-07-12T11:00:00.000Z',
        source: 'direct',
        planItemId: null,
        session,
      }),
    );

    const onNotice = vi.fn();
    render(
      <ActiveCookResumeCard
        scope={SCOPE}
        recipes={[recipe]}
        foods={[makeFood()]}
        onResume={vi.fn()}
        onNotice={onNotice}
        now={NOW}
      />,
    );

    await user.click(screen.getByRole('button', { name: '放弃' }));
    await waitFor(() => {
      expect(screen.queryByTestId('active-cook-resume-card')).not.toBeInTheDocument();
    });
    expect(localStorage.getItem(buildCookSessionV3Key(SCOPE, recipe.id, { kind: 'direct' }))).toBeNull();
    expect(localStorage.getItem(buildActiveCookDescriptorKey(SCOPE))).toBeNull();
    expect(localStorage.getItem(otherKey)).not.toBeNull();
    expect(onNotice).toHaveBeenCalledWith(
      expect.objectContaining({ title: '已放弃上次做菜' }),
    );
  });

  it('clears missing recipe targets and shows a recoverable notice', async () => {
    const recipe = makeRecipe();
    const session = buildDefaultCookSessionV3(recipe, {
      source: 'direct',
      planItemId: null,
      completionRequestId: 'cook-missing',
    });
    saveCookSessionV3({
      scope: SCOPE,
      recipeId: recipe.id,
      session,
      savedAt: '2026-07-12T11:00:00.000Z',
    });

    const onNotice = vi.fn();
    render(
      <ActiveCookResumeCard
        scope={SCOPE}
        recipes={[]}
        foods={[makeFood()]}
        onResume={vi.fn()}
        onNotice={onNotice}
        now={NOW}
      />,
    );

    await waitFor(() => {
      expect(localStorage.getItem(buildCookSessionV3Key(SCOPE, recipe.id, { kind: 'direct' }))).toBeNull();
    });
    expect(onNotice).toHaveBeenCalledWith(
      expect.objectContaining({ title: '上次做菜已失效' }),
    );
    expect(screen.queryByTestId('active-cook-resume-card')).not.toBeInTheDocument();
  });

  it('does not auto-open a cook task from a descriptor alone', () => {
    const recipe = makeRecipe();
    const session = buildDefaultCookSessionV3(recipe, {
      source: 'direct',
      planItemId: null,
      completionRequestId: 'cook-no-auto',
    });
    saveCookSessionV3({
      scope: SCOPE,
      recipeId: recipe.id,
      session,
      savedAt: '2026-07-12T11:00:00.000Z',
    });
    const onResume = vi.fn();
    render(
      <ActiveCookResumeCard
        scope={SCOPE}
        recipes={[recipe]}
        foods={[makeFood()]}
        onResume={onResume}
        now={NOW}
      />,
    );
    expect(onResume).not.toHaveBeenCalled();
    expect(screen.getByTestId('active-cook-resume-card')).toBeInTheDocument();
  });
});
