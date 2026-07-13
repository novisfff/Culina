import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockRequest = vi.fn();

vi.mock('./request', () => ({
  request: (...args: unknown[]) => mockRequest(...args),
}));

import { foodsApi } from './foodsApi';

describe('foodsApi activity highlights', () => {
  beforeEach(() => {
    mockRequest.mockReset();
  });

  it('requests the five-item activity highlight response', async () => {
    mockRequest.mockResolvedValueOnce({ items: [], week_highlight_count: 0 });
    await foodsApi.getActivityHighlights(5);
    expect(mockRequest).toHaveBeenCalledWith('/api/activity-highlights?limit=5');
  });
});

describe('foodsApi food plan detail', () => {
  beforeEach(() => {
    mockRequest.mockReset();
  });

  it('loads one FoodPlanItem by ID', async () => {
    mockRequest.mockResolvedValueOnce({
      id: 'plan-1',
      food_id: 'food-1',
      updated_at: '2026-07-12T08:00:00Z',
    });

    await expect(foodsApi.getFoodPlanItem('plan-1')).resolves.toMatchObject({ id: 'plan-1' });
    expect(mockRequest).toHaveBeenCalledWith('/api/food-plan/plan-1');
  });
});
