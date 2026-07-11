import { afterEach, describe, expect, it, vi } from 'vitest';
import { ingredientsApi } from './ingredientsApi';
import { ApiError, isApiError, setAccessToken } from './request';

afterEach(() => {
  vi.unstubAllGlobals();
  setAccessToken(null);
});

function mockJsonFetch(payload: unknown = {}, status = 200) {
  const fetchSpy = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
    new Response(JSON.stringify(payload), {
      status,
      statusText: status === 200 ? 'OK' : 'Error',
      headers: { 'Content-Type': 'application/json' },
    }),
  );
  vi.stubGlobal('fetch', fetchSpy);
  return fetchSpy;
}

describe('ingredientsApi versioned expiry actions', () => {
  it('sends versioned dispose-expired payload', async () => {
    const fetchSpy = mockJsonFetch({
      ingredient_id: 'ingredient-1',
      disposed_item_ids: ['inventory-1'],
      disposed_count: 1,
    });

    await ingredientsApi.disposeExpiredInventory({
      ingredient_id: 'ingredient-1',
      items: [{ inventory_item_id: 'inventory-1', expected_row_version: 4 }],
    });

    expect(String(fetchSpy.mock.calls[0]?.[0])).toContain('/api/inventory/dispose-expired');
    expect(fetchSpy.mock.calls[0]?.[1]).toMatchObject({ method: 'POST' });
    expect(JSON.parse(String(fetchSpy.mock.calls[0]?.[1]?.body))).toEqual({
      ingredient_id: 'ingredient-1',
      items: [{ inventory_item_id: 'inventory-1', expected_row_version: 4 }],
    });
  });

  it('sends snooze-expiry-alerts payload', async () => {
    const fetchSpy = mockJsonFetch({
      ingredient_id: 'ingredient-1',
      snoozed_item_ids: ['inventory-1'],
      snoozed_count: 1,
      reviewed_expired_count: 1,
      snoozed_until: '2026-07-14',
    });

    await ingredientsApi.snoozeInventoryExpiryAlerts({
      action: 'retain_expired',
      ingredient_id: 'ingredient-1',
      items: [{ inventory_item_id: 'inventory-1', expected_row_version: 2 }],
      snoozed_until: '2026-07-14',
    });

    expect(String(fetchSpy.mock.calls[0]?.[0])).toContain('/api/inventory/snooze-expiry-alerts');
    expect(fetchSpy.mock.calls[0]?.[1]).toMatchObject({ method: 'POST' });
    expect(JSON.parse(String(fetchSpy.mock.calls[0]?.[1]?.body))).toEqual({
      action: 'retain_expired',
      ingredient_id: 'ingredient-1',
      items: [{ inventory_item_id: 'inventory-1', expected_row_version: 2 }],
      snoozed_until: '2026-07-14',
    });
  });

  it('sends expiry-date correction payload', async () => {
    const fetchSpy = mockJsonFetch({ id: 'inventory-1', row_version: 3 });

    await ingredientsApi.correctInventoryExpiryDate('inventory-1', {
      expiry_date: '2026-07-20',
      expected_row_version: 2,
    });

    expect(String(fetchSpy.mock.calls[0]?.[0])).toContain('/api/inventory/inventory-1/expiry-date');
    expect(fetchSpy.mock.calls[0]?.[1]).toMatchObject({ method: 'PATCH' });
    expect(JSON.parse(String(fetchSpy.mock.calls[0]?.[1]?.body))).toEqual({
      expiry_date: '2026-07-20',
      expected_row_version: 2,
    });
  });

  it('surfaces 409 conflicts as ApiError with status 409', async () => {
    mockJsonFetch({ detail: '库存已被其他家人更新，请刷新后再试' }, 409);

    await expect(
      ingredientsApi.disposeExpiredInventory({
        ingredient_id: 'ingredient-1',
        items: [{ inventory_item_id: 'inventory-1', expected_row_version: 1 }],
      }),
    ).rejects.toMatchObject({
      name: 'ApiError',
      status: 409,
      path: '/api/inventory/dispose-expired',
    });

    await ingredientsApi
      .disposeExpiredInventory({
        ingredient_id: 'ingredient-1',
        items: [{ inventory_item_id: 'inventory-1', expected_row_version: 1 }],
      })
      .catch((reason) => {
        expect(reason).toBeInstanceOf(ApiError);
        expect(isApiError(reason)).toBe(true);
        expect(reason.status).toBe(409);
      });
  });
});
