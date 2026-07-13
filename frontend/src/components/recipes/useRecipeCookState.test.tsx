// @vitest-environment jsdom

import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Recipe } from '../../api/types';
import {
  buildCookSessionV3Key,
  buildDefaultCookSessionV3,
  readActiveCook,
  saveCookSessionV3,
  type RecipeCookSessionScope,
} from './recipeCookSessionStorage';
import { useRecipeCookState } from './useRecipeCookState';
import type { RecipeCardViewModel } from './workspaceModel';

const SCOPE: RecipeCookSessionScope = { userId: 'u1', familyId: 'f1' };

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

function makeCard(recipe: Recipe = makeRecipe()): RecipeCardViewModel {
  return {
    recipe,
    availability: 'ready',
    availabilityLabel: '可做',
    availabilityDetail: '',
    availabilityScore: 1,
    shortages: [],
    ingredientAvailability: [],
    ingredientPreview: [],
    hiddenIngredientCount: 0,
    linkedFood: null,
    mealUsageCount: 0,
    lastUsedAt: null,
    searchText: recipe.title,
    updatedAt: recipe.updated_at,
  };
}

beforeEach(() => {
  // jsdom does not implement scrollTo; openCook uses it for focus reset.
  window.scrollTo = vi.fn() as unknown as typeof window.scrollTo;
});

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe('useRecipeCookState scoped v3', () => {
  it('restores the same scoped session and reuses completionRequestId', async () => {
    const recipe = makeRecipe();
    const card = makeCard(recipe);
    const session = buildDefaultCookSessionV3(recipe, {
      source: 'direct',
      planItemId: null,
      completionRequestId: 'cook-stable-restore',
      date: '2026-07-10',
      mealType: 'lunch',
      servings: 3,
    });
    session.currentStepIndex = 0;
    session.adjustments = '少盐';
    saveCookSessionV3({
      scope: SCOPE,
      recipeId: recipe.id,
      session,
      savedAt: new Date().toISOString(),
    });

    const { result } = renderHook(() =>
      useRecipeCookState({
        cards: [card],
        selectedCard: card,
        view: 'library',
        setView: vi.fn(),
        setSelectedRecipeId: vi.fn(),
        previewCookRecipe: vi.fn(async () => ({ preview_items: [], shortages: [] }) as never),
        cookRecipe: vi.fn(async () => ({}) as never),
        showRecipeNotice: vi.fn(),
        sessionScope: SCOPE,
        foodId: 'food-1',
        ownershipVerified: true,
        launchContext: {
          date: '2026-07-12',
          mealType: 'dinner',
          servings: 1,
          source: { kind: 'direct' },
        },
      }),
    );

    act(() => {
      result.current.openCook(card);
    });

    await waitFor(() => {
      expect(result.current.cookSession).not.toBeNull();
    });
    expect(result.current.wasCookSessionRestored).toBe(true);
    expect((result.current.cookSession as { completionRequestId?: string })?.completionRequestId).toBe(
      'cook-stable-restore',
    );
    expect(result.current.cookSession?.date).toBe('2026-07-10');
    expect(result.current.cookSession?.mealType).toBe('lunch');
    expect(result.current.cookSession?.servings).toBe('3');
    expect(result.current.cookSession?.adjustments).toBe('少盐');
  });

  it('requires explicit continue or abandon when another descriptor is active', () => {
    const recipeA = makeRecipe({ id: 'recipe-a', title: 'A' });
    const recipeB = makeRecipe({ id: 'recipe-b', title: 'B' });
    const cardA = makeCard(recipeA);
    const cardB = makeCard(recipeB);
    saveCookSessionV3({
      scope: SCOPE,
      recipeId: recipeA.id,
      session: buildDefaultCookSessionV3(recipeA, {
        source: 'direct',
        planItemId: null,
        completionRequestId: 'cook-a',
      }),
      savedAt: new Date().toISOString(),
    });

    const { result } = renderHook(() =>
      useRecipeCookState({
        cards: [cardA, cardB],
        selectedCard: null,
        view: 'library',
        setView: vi.fn(),
        setSelectedRecipeId: vi.fn(),
        previewCookRecipe: vi.fn(async () => ({ preview_items: [], shortages: [] }) as never),
        cookRecipe: vi.fn(async () => ({}) as never),
        showRecipeNotice: vi.fn(),
        sessionScope: SCOPE,
        foodId: 'food-b',
        ownershipVerified: true,
      }),
    );

    act(() => {
      result.current.openCook(cardB);
    });

    expect(result.current.cookCollision).not.toBeNull();
    expect(result.current.cookCollision?.existing.recipeId).toBe('recipe-a');
    expect(result.current.cookSession).toBeNull();
    expect(readActiveCook(localStorage, SCOPE)?.recipeId).toBe('recipe-a');
  });

  it('abandons the previous descriptor before starting a new cook', async () => {
    const recipeA = makeRecipe({ id: 'recipe-a' });
    const recipeB = makeRecipe({ id: 'recipe-b' });
    const cardA = makeCard(recipeA);
    const cardB = makeCard(recipeB);
    saveCookSessionV3({
      scope: SCOPE,
      recipeId: recipeA.id,
      session: buildDefaultCookSessionV3(recipeA, {
        source: 'direct',
        planItemId: null,
        completionRequestId: 'cook-a',
      }),
      savedAt: new Date().toISOString(),
    });

    const setView = vi.fn();
    const { result } = renderHook(() =>
      useRecipeCookState({
        cards: [cardA, cardB],
        selectedCard: null,
        view: 'library',
        setView,
        setSelectedRecipeId: vi.fn(),
        previewCookRecipe: vi.fn(async () => ({ preview_items: [], shortages: [] }) as never),
        cookRecipe: vi.fn(async () => ({}) as never),
        showRecipeNotice: vi.fn(),
        sessionScope: SCOPE,
        foodId: 'food-b',
        ownershipVerified: true,
      }),
    );

    act(() => {
      result.current.openCook(cardB);
    });
    act(() => {
      result.current.abandonAndStartNewCook();
    });

    await waitFor(() => {
      expect(result.current.cookSession).not.toBeNull();
    });
    expect(result.current.cookCollision).toBeNull();
    expect(readActiveCook(localStorage, SCOPE)?.recipeId).toBe('recipe-b');
    expect(localStorage.getItem(buildCookSessionV3Key(SCOPE, 'recipe-a', { kind: 'direct' }))).toBeNull();
  });

  it('sends always-record payload with stable completion request id', async () => {
    const recipe = makeRecipe();
    const card = makeCard(recipe);
    const session = buildDefaultCookSessionV3(recipe, {
      source: 'plan',
      planItemId: 'plan-1',
      completionRequestId: 'cook-request-1',
      planItemBaseUpdatedAt: '2026-07-12T10:00:00Z',
      date: '2026-07-12',
      mealType: 'dinner',
      servings: 2,
    });
    saveCookSessionV3({
      scope: SCOPE,
      recipeId: recipe.id,
      session,
      savedAt: new Date().toISOString(),
    });
    const cookRecipe = vi.fn(async () => ({
      recipe_id: recipe.id,
      consumed_items: [],
      shortages: [],
      meal_log_id: 'meal-1',
      cook_log_id: 'cook-1',
    }));
    const { result } = renderHook(() =>
      useRecipeCookState({
        cards: [card],
        selectedCard: card,
        view: 'library',
        setView: vi.fn(),
        setSelectedRecipeId: vi.fn(),
        previewCookRecipe: vi.fn(async () => ({ recipe_id: recipe.id, preview_items: [], shortages: [] })),
        cookRecipe,
        showRecipeNotice: vi.fn(),
        sessionScope: SCOPE,
        foodId: 'food-1',
        ownershipVerified: true,
        launchContext: {
          date: '2026-07-12',
          mealType: 'dinner',
          servings: 2,
          source: { kind: 'plan', foodPlanItemId: 'plan-1', planItemBaseUpdatedAt: '2026-07-12T10:00:00Z' },
        },
      }),
    );
    act(() => {
      result.current.openCook(card, 'plan-1');
    });
    await waitFor(() => expect(result.current.cookSession).not.toBeNull());
    act(() => {
      result.current.setIsCookFinishOpen(true);
    });
    await act(async () => {
      await result.current.submitCookRecipe({ preventDefault() {} } as never);
    });
    expect(cookRecipe).toHaveBeenCalledWith(
      recipe.id,
      expect.objectContaining({
        completion_request_id: 'cook-request-1',
        food_plan_item_id: 'plan-1',
        food_plan_item_base_updated_at: '2026-07-12T10:00:00Z',
      }),
    );
    const submittedCall = cookRecipe.mock.calls.at(0) as unknown as [string, Record<string, unknown>] | undefined;
    expect(submittedCall).toBeDefined();
    expect(submittedCall?.[1]).not.toHaveProperty('create_meal_log');
    expect(result.current.cookCompletionResult?.mealLogId).toBe('meal-1');
    expect(localStorage.getItem(buildCookSessionV3Key(SCOPE, recipe.id, { kind: 'plan', foodPlanItemId: 'plan-1' }))).toBeNull();
  });

  it('does not resurrect a cleared session when a timer keeps ticking after success', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const recipe = makeRecipe();
    const card = makeCard(recipe);
    const sessionKey = buildCookSessionV3Key(SCOPE, recipe.id, { kind: 'direct' });
    const cookRecipe = vi.fn(async () => ({
      recipe_id: recipe.id,
      consumed_items: [],
      shortages: [],
      meal_log_id: 'meal-timer-1',
      cook_log_id: 'cook-timer-1',
    }));

    const { result, rerender } = renderHook(
      ({ view }: { view: 'library' | 'cook' }) =>
        useRecipeCookState({
          cards: [card],
          selectedCard: card,
          view,
          setView: vi.fn(),
          setSelectedRecipeId: vi.fn(),
          previewCookRecipe: vi.fn(async () => ({ recipe_id: recipe.id, preview_items: [], shortages: [] })),
          cookRecipe,
          showRecipeNotice: vi.fn(),
          sessionScope: SCOPE,
          foodId: 'food-1',
          ownershipVerified: true,
        }),
      { initialProps: { view: 'library' as 'library' | 'cook' } },
    );

    act(() => {
      result.current.openCook(card);
    });
    rerender({ view: 'cook' });
    await waitFor(() => expect(result.current.cookSession).not.toBeNull());

    act(() => {
      result.current.startTimerById();
    });
    expect(result.current.cookSession?.timers.some((timer) => timer.running)).toBe(true);

    await act(async () => {
      await result.current.submitCookRecipe({ preventDefault() {} } as never);
    });
    expect(result.current.cookCompletionResult?.mealLogId).toBe('meal-timer-1');
    expect(localStorage.getItem(sessionKey)).toBeNull();
    expect(readActiveCook(localStorage, SCOPE)).toBeNull();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2500);
    });

    act(() => {
      result.current.dismissCookCompletion();
    });

    expect(localStorage.getItem(sessionKey)).toBeNull();
    expect(readActiveCook(localStorage, SCOPE)).toBeNull();
    vi.useRealTimers();
  });

  it('keeps the session when a nominal response is missing either result ID', async () => {
    const recipe = makeRecipe();
    const card = makeCard(recipe);
    const session = buildDefaultCookSessionV3(recipe, {
      source: 'direct',
      planItemId: null,
      completionRequestId: 'cook-incomplete-1',
    });
    saveCookSessionV3({
      scope: SCOPE,
      recipeId: recipe.id,
      session,
      savedAt: new Date().toISOString(),
    });
    const cookRecipe = vi.fn(async () => ({
      recipe_id: recipe.id,
      consumed_items: [],
      shortages: [],
      meal_log_id: null,
      cook_log_id: 'cook-1',
    }));
    const showRecipeNotice = vi.fn();
    const { result } = renderHook(() =>
      useRecipeCookState({
        cards: [card],
        selectedCard: card,
        view: 'library',
        setView: vi.fn(),
        setSelectedRecipeId: vi.fn(),
        previewCookRecipe: vi.fn(async () => ({ recipe_id: recipe.id, preview_items: [], shortages: [] })),
        cookRecipe,
        showRecipeNotice,
        sessionScope: SCOPE,
        foodId: 'food-1',
        ownershipVerified: true,
      }),
    );
    act(() => {
      result.current.openCook(card);
    });
    await waitFor(() => expect(result.current.cookSession).not.toBeNull());
    await act(async () => {
      await result.current.submitCookRecipe({ preventDefault() {} } as never);
    });
    expect(result.current.cookFinishStatusMessage).toContain('完成结果不完整');
    expect(result.current.cookCompletionResult).toBeNull();
    expect(localStorage.getItem(buildCookSessionV3Key(SCOPE, recipe.id, { kind: 'direct' }))).not.toBeNull();
    expect(showRecipeNotice).toHaveBeenCalledWith(expect.objectContaining({ tone: 'danger' }));
  });

});
