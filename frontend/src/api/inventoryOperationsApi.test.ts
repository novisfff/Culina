import { afterEach, describe, expect, it, vi } from 'vitest';
import { inventoryOperationsApi } from './inventoryOperationsApi';
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

describe('inventoryOperationsApi', () => {
  it('loads reconciliation scopes and optional storage location', async () => {
    const fetchSpy = mockJsonFetch({ groups: [] });
    await inventoryOperationsApi.getInventoryReconciliation({
      scope: 'refrigerated',
      storage_location: '冷藏',
    });
    expect(String(fetchSpy.mock.calls[0]?.[0])).toContain('/api/inventory/reconciliation');
    expect(String(fetchSpy.mock.calls[0]?.[0])).toContain('scope=refrigerated');
    expect(String(fetchSpy.mock.calls[0]?.[0])).toContain('%E5%86%B7%E8%97%8F');
  });

  it('submits reconciliation payload', async () => {
    const payload = {
      client_request_id: 'recon-1',
      scope: 'suggested' as const,
      storage_location: null,
      groups: [
        {
          kind: 'food' as const,
          food_id: 'food-1',
          expected_row_version: 2,
          action: 'confirm' as const,
          stock_quantity: null,
          stock_unit: null,
          expiry_date: null,
          storage_location: null,
        },
      ],
    };
    const fetchSpy = mockJsonFetch({
      operation_id: 'op-1',
      operation_type: 'reconciliation',
      status: 'applied',
    });
    await inventoryOperationsApi.submitInventoryReconciliation(payload);
    expect(String(fetchSpy.mock.calls[0]?.[0])).toContain('/api/inventory/reconciliations');
    expect(fetchSpy.mock.calls[0]?.[1]).toMatchObject({ method: 'POST' });
    expect(JSON.parse(String(fetchSpy.mock.calls[0]?.[1]?.body))).toEqual(payload);
  });

  it('submits shopping intake payload', async () => {
    const payload = {
      client_request_id: 'intake-1',
      purchase_date: '2026-07-12',
      items: [
        {
          shopping_item_id: 'shop-1',
          expected_shopping_item_row_version: 1,
          action: 'complete_without_inventory' as const,
          target_kind: 'none' as const,
          target_id: null,
        },
      ],
    };
    const fetchSpy = mockJsonFetch({
      operation_id: 'op-2',
      operation_type: 'shopping_intake',
      status: 'applied',
      items: [],
    });
    await inventoryOperationsApi.submitShoppingIntake(payload);
    expect(String(fetchSpy.mock.calls[0]?.[0])).toContain('/api/shopping-list/intakes');
    expect(fetchSpy.mock.calls[0]?.[1]).toMatchObject({ method: 'POST' });
    expect(JSON.parse(String(fetchSpy.mock.calls[0]?.[1]?.body))).toEqual(payload);
  });

  it('lists and reverts inventory operations', async () => {
    const listSpy = mockJsonFetch([{ operation_id: 'op-1' }]);
    await inventoryOperationsApi.listInventoryOperations({ limit: 20 });
    expect(String(listSpy.mock.calls[0]?.[0])).toContain('/api/inventory/operations');
    expect(String(listSpy.mock.calls[0]?.[0])).toContain('limit=20');

    const detailSpy = mockJsonFetch({ operation_id: 'op-1' });
    await inventoryOperationsApi.getInventoryOperation('op-1');
    expect(String(detailSpy.mock.calls[0]?.[0])).toContain('/api/inventory/operations/op-1');

    const revertSpy = mockJsonFetch({ operation_id: 'op-1', status: 'reverted' });
    await inventoryOperationsApi.revertInventoryOperation('op-1');
    expect(String(revertSpy.mock.calls[0]?.[0])).toContain('/api/inventory/operations/op-1/revert');
    expect(revertSpy.mock.calls[0]?.[1]).toMatchObject({ method: 'POST' });
  });

  it('preserves structured 409 conflict detail for intake', async () => {
    mockJsonFetch(
      {
        detail: {
          code: 'stale_version',
          message: '采购项已被其他成员更新，请刷新后重试',
          conflicts: [
            {
              entity_type: 'shopping_list_item',
              entity_id: 'shop-1',
              expected_row_version: 1,
              current_row_version: 3,
            },
          ],
        },
      },
      409,
    );
    await inventoryOperationsApi
      .submitShoppingIntake({
        client_request_id: 'intake-stale',
        purchase_date: '2026-07-12',
        items: [
          {
            shopping_item_id: 'shop-1',
            expected_shopping_item_row_version: 1,
            action: 'complete_without_inventory',
            target_kind: 'none',
            target_id: null,
          },
        ],
      })
      .catch((reason) => {
        expect(reason).toBeInstanceOf(ApiError);
        expect(isApiError(reason)).toBe(true);
        expect(reason.status).toBe(409);
        expect(reason.payload).toMatchObject({
          detail: expect.objectContaining({ code: 'stale_version' }),
        });
      });
  });

  it('preserves structured 422 validation detail for reconciliation', async () => {
    mockJsonFetch(
      {
        detail: {
          code: 'duplicate_request_item',
          message: '请求中包含重复目标',
          field_errors: [{ path: 'groups.0.ingredient_id', message: '重复' }],
        },
      },
      422,
    );
    await inventoryOperationsApi
      .submitInventoryReconciliation({
        client_request_id: 'recon-invalid',
        scope: 'all',
        storage_location: null,
        groups: [
          {
            kind: 'presence_ingredient',
            ingredient_id: 'ingredient-1',
            state_id: null,
            expected_ingredient_row_version: 1,
            expected_state_row_version: null,
            availability_level: 'low',
            inventory_status: 'fresh',
            purchase_date: null,
            expiry_date: null,
            storage_location: '常温',
            notes: '',
          },
        ],
      })
      .catch((reason) => {
        expect(reason).toBeInstanceOf(ApiError);
        expect(isApiError(reason)).toBe(true);
        expect(reason.status).toBe(422);
        expect(reason.payload).toMatchObject({
          detail: expect.objectContaining({ code: 'duplicate_request_item' }),
        });
      });
  });
});
