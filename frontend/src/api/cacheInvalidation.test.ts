import type { QueryClient } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';
import {
  invalidateAfterAiApprovalSettled,
  invalidateAfterAiImageJobChanged,
  invalidateAfterFoodChanged,
  invalidateAfterFoodPlanChanged,
  invalidateAfterFoodPlanCompleted,
  invalidateAfterInventoryChanged,
  invalidateAfterInventoryOperation,
  invalidateAfterMealCompositionChanged,
  invalidateAfterMealLogChanged,
  invalidateAfterMealRecorded,
  invalidateAfterMealRecordReverted,
  invalidateAfterMemberChanged,
  invalidateAfterRecipeCooked,
  invalidateAfterSearchIndexJobChanged,
  invalidateAfterShoppingChanged,
} from './cacheInvalidation';
import { queryKeys } from './queryKeys';

function fakeQueryClient() {
  return {
    invalidateQueries: vi.fn(async () => undefined),
  } as unknown as QueryClient & { invalidateQueries: ReturnType<typeof vi.fn> };
}

function invalidatedKeys(queryClient: ReturnType<typeof fakeQueryClient>) {
  return queryClient.invalidateQueries.mock.calls.map(([args]) => args?.queryKey);
}

function containsKey(keys: unknown[], expected: unknown) {
  return keys.some((key) => JSON.stringify(key) === JSON.stringify(expected));
}

describe('cacheInvalidation', () => {
  it('invalidates search root and affected domain when a search index job changes', async () => {
    const queryClient = fakeQueryClient();

    await invalidateAfterSearchIndexJobChanged(queryClient, { entity_type: 'recipe', entity_id: 'recipe-1' });

    expect(invalidatedKeys(queryClient)).toEqual([
      ['search-index-jobs'],
      ['search'],
      ['recipes'],
      ['recipe-discovery'],
      ['recipe-stats'],
      ['foods'],
      ['food-recommendations'],
      ['activity-logs'],
    ]);
  });

  it('invalidates meal, inventory and plan data after cooking a recipe', async () => {
    const queryClient = fakeQueryClient();

    await invalidateAfterRecipeCooked(queryClient);

    expect(invalidatedKeys(queryClient)).toEqual([
      ['inventory'],
      ['inventory', 'states'],
      ['inventory', 'overview'],
      ['inventory', 'operations'],
      ['recipes'],
      ['recipe-discovery'],
      ['recipe-stats'],
      ['foods'],
      ['food-recommendations'],
      ['meal-logs'],
      ['meal-logs', 'candidates'],
      ['meal-logs', 'insights'],
      ['food-plan'],
      ['shopping-list'],
      ['activity-logs'],
      ['activity-highlights'],
    ]);
  });

  it('invalidates the inventory overview root for food changes', async () => {
    const foodQueryClient = fakeQueryClient();
    await invalidateAfterFoodChanged(foodQueryClient);

    expect(invalidatedKeys(foodQueryClient)).toEqual([
      ['foods'],
      ['inventory', 'overview'],
      ['food-recommendations'],
      ['meal-logs', 'insights'],
      ['activity-logs'],
    ]);
  });

  it('waits for every inventory invalidation key before completing', async () => {
    const queryClient = fakeQueryClient();
    let resolveFourth: (() => void) | undefined;
    const fourth = new Promise<void>((resolve) => {
      resolveFourth = resolve;
    });
    let callIndex = 0;
    queryClient.invalidateQueries.mockImplementation(async () => {
      callIndex += 1;
      if (callIndex === 5) {
        await fourth;
      }
    });

    let settled = false;
    const pending = invalidateAfterInventoryChanged(queryClient).then(() => {
      settled = true;
    });

    await Promise.resolve();
    expect(settled).toBe(false);
    expect(invalidatedKeys(queryClient)).toEqual([
      ['inventory'],
      ['inventory', 'states'],
      ['inventory', 'overview'],
      ['food-recommendations'],
      ['activity-logs'],
      ['activity-highlights'],
    ]);

    resolveFourth?.();
    await pending;
    expect(settled).toBe(true);
  });

  it('invalidates the inventory overview root after inventory changes', async () => {
    const queryClient = fakeQueryClient();

    await invalidateAfterInventoryChanged(queryClient);

    expect(invalidatedKeys(queryClient)).toEqual([
      ['inventory'],
      ['inventory', 'states'],
      ['inventory', 'overview'],
      ['food-recommendations'],
      ['activity-logs'],
      ['activity-highlights'],
    ]);
  });

  it('invalidates active conversation contracts after an AI approval settles', async () => {
    const queryClient = fakeQueryClient();

    await invalidateAfterAiApprovalSettled(queryClient, 'conversation-1');

    expect(invalidatedKeys(queryClient)).toEqual([
      ['ai-messages', 'conversation-1'],
      ['ai-pending-approvals', 'conversation-1'],
      ['ai-conversations'],
      ['ai-quality-metrics'],
      ['inventory'],
      ['inventory', 'states'],
      ['inventory', 'overview'],
      ['recipes'],
      ['shopping-list'],
      ['food-plan'],
      ['meal-logs'],
      ['meal-logs', 'candidates'],
      ['meal-logs', 'insights'],
      ['foods'],
      ['food-recommendations'],
      ['activity-logs'],
      ['activity-highlights'],
    ]);
  });

  it('invalidates target-specific data after an AI image job changes', async () => {
    const queryClient = fakeQueryClient();

    await invalidateAfterAiImageJobChanged(queryClient, { target_entity_type: 'family', target_entity_id: 'family-1' });

    expect(invalidatedKeys(queryClient)).toEqual([
      ['ai-image-jobs'],
      ['family'],
      ['auth', 'me'],
      ['activity-logs'],
    ]);
  });

  it('invalidates inventory maintenance consumers after an inventory operation', async () => {
    const queryClient = fakeQueryClient();

    await invalidateAfterInventoryOperation(queryClient);

    expect(invalidatedKeys(queryClient)).toEqual([
      ['inventory'],
      ['inventory', 'states'],
      ['inventory', 'overview'],
      ['inventory', 'operations'],
      ['ingredients'],
      ['foods'],
      ['shopping-list'],
      ['food-plan'],
      ['food-recommendations'],
      ['recipe-discovery'],
      ['search'],
      ['activity-logs'],
      ['activity-highlights'],
    ]);
  });

  it.each([
    invalidateAfterInventoryOperation,
    invalidateAfterFoodPlanChanged,
    invalidateAfterRecipeCooked,
    invalidateAfterMealLogChanged,
    invalidateAfterMealRecorded,
  ])('invalidates the activity-highlight prefix for eligible outcomes', async (invalidate) => {
    const queryClient = fakeQueryClient();
    await invalidate(queryClient);
    expect(queryClient.invalidateQueries).toHaveBeenCalledWith({
      queryKey: queryKeys.activityHighlights,
    });
  });

  it('invalidates the activity-highlight prefix after inventory changes including disposal', async () => {
    const queryClient = fakeQueryClient();
    await invalidateAfterInventoryChanged(queryClient);
    expect(queryClient.invalidateQueries).toHaveBeenCalledWith({
      queryKey: queryKeys.activityHighlights,
    });
  });

  it('covers food plan detail under foodPlanRoot invalidation', async () => {
    const queryClient = fakeQueryClient();
    await invalidateAfterFoodPlanChanged(queryClient);
    expect(queryClient.invalidateQueries).toHaveBeenCalledWith({
      queryKey: queryKeys.foodPlanRoot,
    });
    expect(queryKeys.foodPlanDetail('plan-1').slice(0, 1)).toEqual(queryKeys.foodPlanRoot);
  });

  it('invalidates the activity-highlight prefix after member changes', async () => {
    const queryClient = fakeQueryClient();
    await invalidateAfterMemberChanged(queryClient);
    expect(queryClient.invalidateQueries).toHaveBeenCalledWith({
      queryKey: queryKeys.activityHighlights,
    });
  });

  it('invalidates the activity-highlight prefix after AI approval settles', async () => {
    const queryClient = fakeQueryClient();
    await invalidateAfterAiApprovalSettled(queryClient, 'conversation-1');
    expect(queryClient.invalidateQueries).toHaveBeenCalledWith({
      queryKey: queryKeys.activityHighlights,
    });
  });

  it('does not add highlight invalidation to ordinary shopping-list changes', async () => {
    const queryClient = fakeQueryClient();
    await invalidateAfterShoppingChanged(queryClient);
    expect(queryClient.invalidateQueries).not.toHaveBeenCalledWith({
      queryKey: queryKeys.activityHighlights,
    });
  });

  it('record invalidation refreshes food plans but excludes inventory', async () => {
    const queryClient = fakeQueryClient();
    await invalidateAfterMealRecorded(queryClient, { createdFood: true });
    const keys = invalidatedKeys(queryClient);

    expect(containsKey(keys, queryKeys.mealLogs)).toBe(true);
    expect(containsKey(keys, queryKeys.mealCandidatesRoot)).toBe(true);
    expect(containsKey(keys, queryKeys.mealInsights)).toBe(true);
    expect(containsKey(keys, queryKeys.mealRecordOperations(true))).toBe(true);
    expect(containsKey(keys, queryKeys.foods)).toBe(true);
    expect(containsKey(keys, queryKeys.foodRecommendations)).toBe(true);
    expect(containsKey(keys, queryKeys.activityLogs)).toBe(true);
    expect(containsKey(keys, queryKeys.activityHighlights)).toBe(true);
    expect(containsKey(keys, queryKeys.inventory)).toBe(false);
    expect(containsKey(keys, queryKeys.foodPlanRoot)).toBe(true);
  });

  it('record without created food skips foods invalidation', async () => {
    const queryClient = fakeQueryClient();
    await invalidateAfterMealRecorded(queryClient, { createdFood: false });
    const keys = invalidatedKeys(queryClient);

    expect(containsKey(keys, queryKeys.mealLogs)).toBe(true);
    expect(containsKey(keys, queryKeys.mealCandidatesRoot)).toBe(true);
    expect(containsKey(keys, queryKeys.mealInsights)).toBe(true);
    expect(containsKey(keys, queryKeys.foods)).toBe(false);
    expect(containsKey(keys, queryKeys.inventory)).toBe(false);
    expect(containsKey(keys, queryKeys.foodPlanRoot)).toBe(true);
  });

  it('composition and rating invalidate meal candidates and insights without inventory or plan', async () => {
    const queryClient = fakeQueryClient();
    await invalidateAfterMealCompositionChanged(queryClient);
    const keys = invalidatedKeys(queryClient);

    expect(containsKey(keys, queryKeys.mealLogs)).toBe(true);
    expect(containsKey(keys, queryKeys.mealCandidatesRoot)).toBe(true);
    expect(containsKey(keys, queryKeys.mealInsights)).toBe(true);
    expect(containsKey(keys, queryKeys.foodRecommendations)).toBe(true);
    expect(containsKey(keys, queryKeys.activityLogs)).toBe(true);
    expect(containsKey(keys, queryKeys.activityHighlights)).toBe(true);
    expect(containsKey(keys, queryKeys.inventory)).toBe(false);
    expect(containsKey(keys, queryKeys.foodPlanRoot)).toBe(false);
  });

  it('revert with removed food invalidates foods and restored plans but not inventory', async () => {
    const withFood = fakeQueryClient();
    await invalidateAfterMealRecordReverted(withFood, { removedFood: true });
    const withFoodKeys = invalidatedKeys(withFood);

    expect(containsKey(withFoodKeys, queryKeys.mealLogs)).toBe(true);
    expect(containsKey(withFoodKeys, queryKeys.mealCandidatesRoot)).toBe(true);
    expect(containsKey(withFoodKeys, queryKeys.mealInsights)).toBe(true);
    expect(containsKey(withFoodKeys, queryKeys.mealRecordOperations(true))).toBe(true);
    expect(containsKey(withFoodKeys, queryKeys.foods)).toBe(true);
    expect(containsKey(withFoodKeys, queryKeys.inventory)).toBe(false);
    expect(containsKey(withFoodKeys, queryKeys.foodPlanRoot)).toBe(true);

    const withoutFood = fakeQueryClient();
    await invalidateAfterMealRecordReverted(withoutFood, { removedFood: false });
    const withoutFoodKeys = invalidatedKeys(withoutFood);
    expect(containsKey(withoutFoodKeys, queryKeys.mealLogs)).toBe(true);
    expect(containsKey(withoutFoodKeys, queryKeys.foods)).toBe(false);
  });

  it('food name or cover changes invalidate meal insights', async () => {
    const queryClient = fakeQueryClient();
    await invalidateAfterFoodChanged(queryClient);
    const keys = invalidatedKeys(queryClient);
    expect(containsKey(keys, queryKeys.mealInsights)).toBe(true);
    expect(containsKey(keys, queryKeys.foods)).toBe(true);
  });

  it('recipe cook invalidates candidates and insights plus real domain keys', async () => {
    const queryClient = fakeQueryClient();
    await invalidateAfterRecipeCooked(queryClient);
    const keys = invalidatedKeys(queryClient);

    expect(containsKey(keys, queryKeys.mealLogs)).toBe(true);
    expect(containsKey(keys, queryKeys.mealCandidatesRoot)).toBe(true);
    expect(containsKey(keys, queryKeys.mealInsights)).toBe(true);
    expect(containsKey(keys, queryKeys.inventory)).toBe(true);
    expect(containsKey(keys, queryKeys.foodPlanRoot)).toBe(true);
    expect(containsKey(keys, queryKeys.recipes)).toBe(true);
  });

  it('plan completion invalidates candidates and insights plus plan domain keys', async () => {
    const queryClient = fakeQueryClient();
    await invalidateAfterFoodPlanCompleted(queryClient);
    const keys = invalidatedKeys(queryClient);

    expect(containsKey(keys, queryKeys.mealLogs)).toBe(true);
    expect(containsKey(keys, queryKeys.mealCandidatesRoot)).toBe(true);
    expect(containsKey(keys, queryKeys.mealInsights)).toBe(true);
    expect(containsKey(keys, queryKeys.foodPlanRoot)).toBe(true);
    expect(containsKey(keys, queryKeys.foodRecommendations)).toBe(true);
    expect(containsKey(keys, queryKeys.activityHighlights)).toBe(true);
    expect(containsKey(keys, queryKeys.inventory)).toBe(false);
  });

  it('AI approval invalidates meal candidates and insights with real domain keys', async () => {
    const queryClient = fakeQueryClient();
    await invalidateAfterAiApprovalSettled(queryClient, 'conversation-1');
    const keys = invalidatedKeys(queryClient);

    expect(containsKey(keys, queryKeys.mealLogs)).toBe(true);
    expect(containsKey(keys, queryKeys.mealCandidatesRoot)).toBe(true);
    expect(containsKey(keys, queryKeys.mealInsights)).toBe(true);
    expect(containsKey(keys, queryKeys.inventory)).toBe(true);
    expect(containsKey(keys, queryKeys.foodPlanRoot)).toBe(true);
  });
});
