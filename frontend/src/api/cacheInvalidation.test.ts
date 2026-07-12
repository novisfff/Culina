import type { QueryClient } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';
import {
  invalidateAfterAiApprovalSettled,
  invalidateAfterAiImageJobChanged,
  invalidateAfterFoodChanged,
  invalidateAfterInventoryChanged,
  invalidateAfterRecipeCooked,
  invalidateAfterQuickMealAdded,
  invalidateAfterSearchIndexJobChanged,
} from './cacheInvalidation';

function fakeQueryClient() {
  return {
    invalidateQueries: vi.fn(async () => undefined),
  } as unknown as QueryClient & { invalidateQueries: ReturnType<typeof vi.fn> };
}

function invalidatedKeys(queryClient: ReturnType<typeof fakeQueryClient>) {
  return queryClient.invalidateQueries.mock.calls.map(([args]) => args?.queryKey);
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
      ['inventory', 'overview'],
      ['recipe-discovery'],
      ['food-recommendations'],
      ['recipe-stats'],
      ['foods'],
      ['meal-logs'],
      ['food-plan'],
      ['activity-logs'],
    ]);
  });

  it('invalidates the inventory overview root for food and quick meal changes', async () => {
    const foodQueryClient = fakeQueryClient();
    await invalidateAfterFoodChanged(foodQueryClient);

    expect(invalidatedKeys(foodQueryClient)).toEqual([
      ['foods'],
      ['inventory', 'overview'],
      ['food-recommendations'],
      ['activity-logs'],
    ]);

    const mealQueryClient = fakeQueryClient();
    await invalidateAfterQuickMealAdded(mealQueryClient);

    expect(invalidatedKeys(mealQueryClient)).toEqual([
      ['meal-logs'],
      ['food-plan'],
      ['foods'],
      ['inventory', 'overview'],
      ['food-recommendations'],
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
      if (callIndex === 4) {
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
      ['inventory', 'overview'],
      ['food-recommendations'],
      ['activity-logs'],
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
      ['inventory', 'overview'],
      ['food-recommendations'],
      ['activity-logs'],
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
      ['inventory', 'overview'],
      ['recipes'],
      ['shopping-list'],
      ['food-plan'],
      ['meal-logs'],
      ['foods'],
      ['food-recommendations'],
      ['activity-logs'],
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
});
