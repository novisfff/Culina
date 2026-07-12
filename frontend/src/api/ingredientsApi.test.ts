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
  it('accepts and sends the observed row version for single-batch disposal', async () => {
    const fetchSpy = mockJsonFetch({
      ingredient_id: 'ingredient-1',
      inventory_item_id: 'inventory-1',
      unit: '个',
      disposed_quantity: 1,
      remaining_quantity: 2,
    });

    await ingredientsApi.disposeInventory({
      inventory_item_id: 'inventory-1',
      expected_row_version: 4,
      quantity: 1,
      unit: '个',
      reason: '损坏',
    });

    expect(JSON.parse(String(fetchSpy.mock.calls[0]?.[1]?.body))).toEqual({
      inventory_item_id: 'inventory-1',
      expected_row_version: 4,
      quantity: 1,
      unit: '个',
      reason: '损坏',
    });
  });

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

describe('ingredientsApi free-text shopping items', () => {
  it('creates a free-text shopping item with null target ids', async () => {
    const fetchSpy = mockJsonFetch({
      id: 'shopping-1',
      family_id: 'family-1',
      ingredient_id: null,
      food_id: null,
      target_type: 'free_text',
      title: '厨房纸',
      quantity: 1,
      unit: '份',
      reason: '家用',
      done: false,
      created_at: '2026-07-12T00:00:00Z',
      updated_at: '2026-07-12T00:00:00Z',
      row_version: 1,
    }, 201);

    await ingredientsApi.createShoppingItem({
      title: '厨房纸',
      quantity: 1,
      unit: '份',
      ingredient_id: null,
      food_id: null,
      reason: '家用',
    });

    expect(String(fetchSpy.mock.calls[0]?.[0])).toContain('/api/shopping-list');
    expect(fetchSpy.mock.calls[0]?.[1]).toMatchObject({ method: 'POST' });
    expect(JSON.parse(String(fetchSpy.mock.calls[0]?.[1]?.body))).toEqual({
      title: '厨房纸',
      quantity: 1,
      unit: '份',
      ingredient_id: null,
      food_id: null,
      reason: '家用',
    });
  });

  it('patches a shopping item with explicit null targets to unbind', async () => {
    const fetchSpy = mockJsonFetch({
      id: 'shopping-1',
      family_id: 'family-1',
      ingredient_id: null,
      food_id: null,
      target_type: 'free_text',
      title: '临时采购',
      quantity: 1,
      unit: '盒',
      reason: '改成自由文本',
      done: false,
      created_at: '2026-07-12T00:00:00Z',
      updated_at: '2026-07-12T00:00:00Z',
      row_version: 2,
    });

    await ingredientsApi.updateShoppingItem('shopping-1', {
      expected_row_version: 1,
      title: '临时采购',
      quantity: 1,
      unit: '盒',
      ingredient_id: null,
      food_id: null,
      reason: '改成自由文本',
    });

    expect(String(fetchSpy.mock.calls[0]?.[0])).toContain('/api/shopping-list/shopping-1');
    expect(fetchSpy.mock.calls[0]?.[1]).toMatchObject({ method: 'PATCH' });
    expect(JSON.parse(String(fetchSpy.mock.calls[0]?.[1]?.body))).toEqual({
      expected_row_version: 1,
      title: '临时采购',
      quantity: 1,
      unit: '盒',
      ingredient_id: null,
      food_id: null,
      reason: '改成自由文本',
    });
  });

  it('sends the observed row version when deleting a shopping item', async () => {
    const fetchSpy = mockJsonFetch();

    await ingredientsApi.deleteShoppingItem('shopping-1', 7);

    expect(String(fetchSpy.mock.calls[0]?.[0])).toContain(
      '/api/shopping-list/shopping-1?expected_row_version=7',
    );
    expect(fetchSpy.mock.calls[0]?.[1]).toMatchObject({ method: 'DELETE' });
  });
});

describe('ingredientsApi versioned profile updates', () => {
  it('sends the observed ingredient row version', async () => {
    const fetchSpy = mockJsonFetch({ id: 'ingredient-1', row_version: 5 });

    await ingredientsApi.updateIngredient('ingredient-1', {
      expected_row_version: 4,
      name: '鸡蛋',
      category: '蛋奶',
      default_unit: '个',
      unit_conversions: [],
      quantity_tracking_mode: 'track_quantity',
      default_storage: '冷藏',
      default_expiry_mode: 'days',
      default_expiry_days: 14,
      default_low_stock_threshold: 6,
      notes: '',
      media_ids: [],
    });

    expect(JSON.parse(String(fetchSpy.mock.calls[0]?.[1]?.body))).toMatchObject({
      name: '鸡蛋',
      expected_row_version: 4,
    });
  });
});



describe('ingredientsApi tracking mode transition', () => {
  it('sends tracking-mode transition payload', async () => {
    const fetchSpy = mockJsonFetch({
      id: 'ingredient-1',
      quantity_tracking_mode: 'not_track_quantity',
      row_version: 2,
    });

    await ingredientsApi.transitionIngredientTrackingMode('ingredient-1', {
      expected_ingredient_row_version: 1,
      target_mode: 'not_track_quantity',
      observed_batches: [{ inventory_item_id: 'inventory-1', expected_row_version: 3 }],
      presence_resolution: {
        availability_level: 'present_unknown',
        inventory_status: 'fresh',
        purchase_date: '2026-07-01',
        expiry_date: null,
        storage_location: '冷藏',
        notes: '',
        mark_inventory_confirmed: true,
      },
    });

    expect(String(fetchSpy.mock.calls[0]?.[0])).toContain('/api/ingredients/ingredient-1/tracking-mode');
    expect(fetchSpy.mock.calls[0]?.[1]).toMatchObject({ method: 'PATCH' });
    expect(JSON.parse(String(fetchSpy.mock.calls[0]?.[1]?.body))).toEqual({
      expected_ingredient_row_version: 1,
      target_mode: 'not_track_quantity',
      observed_batches: [{ inventory_item_id: 'inventory-1', expected_row_version: 3 }],
      presence_resolution: {
        availability_level: 'present_unknown',
        inventory_status: 'fresh',
        purchase_date: '2026-07-01',
        expiry_date: null,
        storage_location: '冷藏',
        notes: '',
        mark_inventory_confirmed: true,
      },
    });
  });
});
