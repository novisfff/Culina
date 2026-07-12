import { afterEach, describe, expect, it, vi } from 'vitest';
import { inventoryStatesApi } from './inventoryStatesApi';
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

describe('inventoryStatesApi', () => {
  it('lists inventory states and optional ingredient filters', async () => {
    const fetchSpy = mockJsonFetch([{ id: 'state-1' }]);
    await inventoryStatesApi.listInventoryStates({ ingredient_ids: ['ingredient-salt'] });
    expect(String(fetchSpy.mock.calls[0]?.[0])).toContain('/api/inventory/states');
    expect(String(fetchSpy.mock.calls[0]?.[0])).toContain('ingredient_ids=ingredient-salt');
  });

  it('upserts inventory state', async () => {
    const fetchSpy = mockJsonFetch({ id: 'state-1', row_version: 2 });
    await inventoryStatesApi.upsertInventoryState('ingredient-salt', {
      expected_ingredient_row_version: 1,
      state_id: 'state-1',
      expected_state_row_version: 1,
      availability_level: 'low',
      inventory_status: 'opened',
      storage_location: '常温',
      notes: '',
    });
    expect(String(fetchSpy.mock.calls[0]?.[0])).toContain('/api/inventory/states/ingredient-salt');
    expect(fetchSpy.mock.calls[0]?.[1]).toMatchObject({ method: 'PUT' });
  });

  it('sends state expiry snooze / correct / set-absent payloads', async () => {
    const snoozeSpy = mockJsonFetch({ id: 'state-1', row_version: 2 });
    await inventoryStatesApi.snoozeStateExpiryAlert('ingredient-salt', {
      action: 'retain_expired',
      state_id: 'state-1',
      expected_row_version: 1,
      snoozed_until: '2026-07-14',
    });
    expect(String(snoozeSpy.mock.calls[0]?.[0])).toContain(
      '/api/inventory/states/ingredient-salt/snooze-expiry-alert',
    );
    expect(JSON.parse(String(snoozeSpy.mock.calls[0]?.[1]?.body))).toEqual({
      action: 'retain_expired',
      state_id: 'state-1',
      expected_row_version: 1,
      snoozed_until: '2026-07-14',
    });

    const correctSpy = mockJsonFetch({ id: 'state-1', row_version: 3 });
    await inventoryStatesApi.correctStateExpiryDate('ingredient-salt', {
      state_id: 'state-1',
      expected_row_version: 2,
      expiry_date: '2026-07-20',
    });
    expect(String(correctSpy.mock.calls[0]?.[0])).toContain(
      '/api/inventory/states/ingredient-salt/expiry-date',
    );
    expect(correctSpy.mock.calls[0]?.[1]).toMatchObject({ method: 'PATCH' });

    const absentSpy = mockJsonFetch({ id: 'state-1', availability_level: 'absent' });
    await inventoryStatesApi.setInventoryStateAbsent('ingredient-salt', {
      state_id: 'state-1',
      expected_row_version: 3,
    });
    expect(String(absentSpy.mock.calls[0]?.[0])).toContain(
      '/api/inventory/states/ingredient-salt/set-absent',
    );
    expect(absentSpy.mock.calls[0]?.[1]).toMatchObject({ method: 'POST' });
  });

  it('preserves structured 409 conflict detail', async () => {
    mockJsonFetch(
      {
        detail: {
          code: 'stale_version',
          message: '库存批次已被其他成员更新，请刷新后重试',
          conflicts: [
            {
              entity_type: 'ingredient_inventory_state',
              entity_id: 'state-1',
              expected_row_version: 1,
              current_row_version: 4,
            },
          ],
        },
      },
      409,
    );
    await inventoryStatesApi
      .setInventoryStateAbsent('ingredient-salt', {
        state_id: 'state-1',
        expected_row_version: 1,
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
});
