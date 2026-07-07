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
    invalidateQueries: vi.fn(),
  } as unknown as QueryClient & { invalidateQueries: ReturnType<typeof vi.fn> };
}

function invalidatedKeys(queryClient: ReturnType<typeof fakeQueryClient>) {
  return queryClient.invalidateQueries.mock.calls.map(([args]) => args?.queryKey);
}

describe('cacheInvalidation', () => {
  it('invalidates search root and affected domain when a search index job changes', () => {
    const queryClient = fakeQueryClient();

    invalidateAfterSearchIndexJobChanged(queryClient, { entity_type: 'recipe', entity_id: 'recipe-1' });

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

  it('invalidates meal, inventory and plan data after cooking a recipe', () => {
    const queryClient = fakeQueryClient();

    invalidateAfterRecipeCooked(queryClient);

    expect(invalidatedKeys(queryClient)).toEqual([
      ['inventory'],
      ['recipe-discovery'],
      ['food-recommendations'],
      ['recipe-stats'],
      ['foods'],
      ['meal-logs'],
      ['food-plan'],
      ['activity-logs'],
    ]);
  });

  it('invalidates the inventory overview root for food and quick meal changes', () => {
    const foodQueryClient = fakeQueryClient();
    invalidateAfterFoodChanged(foodQueryClient);

    expect(invalidatedKeys(foodQueryClient)).toEqual([
      ['foods'],
      ['inventory', 'overview'],
      ['food-recommendations'],
      ['activity-logs'],
    ]);

    const mealQueryClient = fakeQueryClient();
    invalidateAfterQuickMealAdded(mealQueryClient);

    expect(invalidatedKeys(mealQueryClient)).toEqual([
      ['meal-logs'],
      ['food-plan'],
      ['foods'],
      ['inventory', 'overview'],
      ['food-recommendations'],
      ['activity-logs'],
    ]);
  });

  it('invalidates the inventory overview root after inventory changes', () => {
    const queryClient = fakeQueryClient();

    invalidateAfterInventoryChanged(queryClient);

    expect(invalidatedKeys(queryClient)).toEqual([
      ['inventory'],
      ['inventory', 'overview'],
      ['food-recommendations'],
      ['activity-logs'],
    ]);
  });

  it('invalidates active conversation contracts after an AI approval settles', () => {
    const queryClient = fakeQueryClient();

    invalidateAfterAiApprovalSettled(queryClient, 'conversation-1');

    expect(invalidatedKeys(queryClient)).toEqual([
      ['ai-messages', 'conversation-1'],
      ['ai-pending-approvals', 'conversation-1'],
      ['ai-conversations'],
      ['ai-quality-metrics'],
      ['inventory'],
      ['recipes'],
      ['shopping-list'],
      ['food-plan'],
      ['meal-logs'],
      ['foods'],
      ['food-recommendations'],
      ['activity-logs'],
    ]);
  });

  it('invalidates target-specific data after an AI image job changes', () => {
    const queryClient = fakeQueryClient();

    invalidateAfterAiImageJobChanged(queryClient, { target_entity_type: 'family', target_entity_id: 'family-1' });

    expect(invalidatedKeys(queryClient)).toEqual([
      ['ai-image-jobs'],
      ['family'],
      ['auth', 'me'],
      ['activity-logs'],
    ]);
  });
});
