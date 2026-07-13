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
