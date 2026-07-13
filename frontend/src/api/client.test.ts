import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from './client';
import { ApiError, getAccessToken, isApiError, setAccessToken } from './request';

afterEach(() => {
  vi.unstubAllGlobals();
  setAccessToken(null);
});

describe('api client errors', () => {
  it('throws ApiError with status, path, detail and payload', async () => {
    const payload = { detail: [{ msg: '字段不能为空' }, { msg: '格式不正确' }] };
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(payload), {
        status: 422,
        statusText: 'Unprocessable Entity',
        headers: { 'Content-Type': 'application/json' },
      }))
    );

    await expect(api.me()).rejects.toMatchObject({
      name: 'ApiError',
      status: 422,
      path: '/api/auth/me',
      detail: '字段不能为空；格式不正确',
      payload,
    });

    await api.me().catch((reason) => {
      expect(reason).toBeInstanceOf(ApiError);
      expect(isApiError(reason)).toBe(true);
      expect(reason).toBeInstanceOf(Error);
      expect(reason.message).toBe('字段不能为空；格式不正确');
    });
  });

  it('uses the message from a structured detail object and preserves the payload', async () => {
    const payload = {
      detail: {
        code: 'stale_version',
        message: '库存批次已被其他成员更新，请刷新后重试',
        conflicts: [{ entity_type: 'inventory_item', entity_id: 'inventory-1' }],
      },
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(payload), {
        status: 409,
        statusText: 'Conflict',
        headers: { 'Content-Type': 'application/json' },
      }))
    );

    await expect(api.me()).rejects.toMatchObject({
      name: 'ApiError',
      status: 409,
      path: '/api/auth/me',
      detail: '库存批次已被其他成员更新，请刷新后重试',
      payload,
    });
  });

  it('clears access token on unauthorized responses', async () => {
    setAccessToken('expired-token');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ detail: '登录已过期' }), {
        status: 401,
        statusText: 'Unauthorized',
        headers: { 'Content-Type': 'application/json' },
      }))
    );

    await expect(api.me()).rejects.toMatchObject({ status: 401, detail: '登录已过期' });
    expect(getAccessToken()).toBeNull();
    expect(localStorage.getItem('culina-access-token')).toBeNull();
  });
});

describe('paged resource lists', () => {
  function mockJsonFetch(payload: unknown = {}) {
    const fetchSpy = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchSpy);
    return fetchSpy;
  }

  it('sends food and ingredient search pagination parameters', async () => {
    const fetchSpy = mockJsonFetch([]);

    await api.getFoods({ q: '番茄 饭', limit: 6, offset: 12 });
    await api.getIngredients({ q: '蔬菜', limit: 6, offset: 6 });
    await api.getInventory({ q: '西红柿' });
    await api.getRecipes({ q: '快手菜', scene: '早餐', difficulty: 'easy', sort: 'time', limit: 8, offset: 4 });

    expect(String(fetchSpy.mock.calls[0]?.[0])).toContain('/api/foods?q=%E7%95%AA%E8%8C%84+%E9%A5%AD&limit=6&offset=12');
    expect(String(fetchSpy.mock.calls[1]?.[0])).toContain('/api/ingredients?q=%E8%94%AC%E8%8F%9C&limit=6&offset=6');
    expect(String(fetchSpy.mock.calls[2]?.[0])).toContain('/api/inventory?q=%E8%A5%BF%E7%BA%A2%E6%9F%BF');
    expect(String(fetchSpy.mock.calls[3]?.[0])).toContain(
      '/api/recipes?q=%E5%BF%AB%E6%89%8B%E8%8F%9C&scene=%E6%97%A9%E9%A4%90&difficulty=easy&sort=time&limit=8&offset=4'
    );
  });

  it('sends unified search parameters', async () => {
    const fetchSpy = mockJsonFetch({
      items: [],
      total: 0,
      query: '清淡晚饭',
      search_mode: 'hybrid',
      degraded: false,
    });

    await api.search({ q: '清淡晚饭', scopes: ['recipe', 'food'], limit: 10, offset: 5 });

    expect(String(fetchSpy.mock.calls[0]?.[0])).toContain(
      '/api/search?q=%E6%B8%85%E6%B7%A1%E6%99%9A%E9%A5%AD&scopes=recipe%2Cfood&limit=10&offset=5'
    );
  });

  it('sends plan, recommendation and stats query parameters', async () => {
    const fetchSpy = mockJsonFetch([]);

    await api.getFoodPlan('2026-06-01', '2026-06-07', ' 晚餐 ');
    await api.getFoodRecommendations({ limit: 5, now: '2026-06-01T18:00:00Z', meal_type: 'dinner' });
    await api.getRecipeStats('2026-06-01', '2026-06-30', 8);

    expect(String(fetchSpy.mock.calls[0]?.[0])).toContain(
      '/api/food-plan?date_from=2026-06-01&date_to=2026-06-07&q=%E6%99%9A%E9%A4%90'
    );
    expect(String(fetchSpy.mock.calls[1]?.[0])).toContain(
      '/api/foods/recommendations?limit=5&now=2026-06-01T18%3A00%3A00Z&meal_type=dinner'
    );
    expect(String(fetchSpy.mock.calls[2]?.[0])).toContain(
      '/api/recipes/stats?limit=8&date_from=2026-06-01&date_to=2026-06-30'
    );
    expect(fetchSpy.mock.calls.map((call) => String(call[0])).join('\n')).not.toContain('/api/recipe-plan');
  });

  it('sends mutation methods and JSON bodies for plan and ingredient updates', async () => {
    const fetchSpy = mockJsonFetch({});

    await api.createFoodPlanItem({ food_id: 'food-1', plan_date: '2026-06-01', meal_type: 'dinner', note: '加班餐' });
    await api.updateFoodPlanItem('plan-1', { status: 'skipped', note: '临时取消' });
    await api.deleteFoodPlanItem('plan-1');
    await api.createIngredient({
      name: '番茄',
      category: '蔬菜',
      default_unit: '个',
      unit_conversions: [],
      quantity_tracking_mode: 'track_quantity',
      default_storage: '冷藏',
      default_expiry_mode: 'days',
      default_expiry_days: 3,
      default_low_stock_threshold: 2,
      notes: '常备',
      media_ids: ['media-1'],
    });

    expect(fetchSpy.mock.calls.map((call) => [String(call[0]), (call[1] as RequestInit | undefined)?.method ?? 'GET'])).toEqual([
      [expect.stringContaining('/api/food-plan'), 'POST'],
      [expect.stringContaining('/api/food-plan/plan-1'), 'PATCH'],
      [expect.stringContaining('/api/food-plan/plan-1'), 'DELETE'],
      [expect.stringContaining('/api/ingredients'), 'POST'],
    ]);
    expect(fetchSpy.mock.calls.map((call) => String(call[0])).join('\n')).not.toContain('/api/recipe-plan');
    expect(JSON.parse(String(fetchSpy.mock.calls[0]?.[1]?.body))).toEqual({
      food_id: 'food-1',
      plan_date: '2026-06-01',
      meal_type: 'dinner',
      note: '加班餐',
    });
    expect(JSON.parse(String(fetchSpy.mock.calls[1]?.[1]?.body))).toEqual({ status: 'skipped', note: '临时取消' });
    expect(JSON.parse(String(fetchSpy.mock.calls[3]?.[1]?.body))).toMatchObject({
      name: '番茄',
      quantity_tracking_mode: 'track_quantity',
      media_ids: ['media-1'],
    });
  });

  it('sends search index job endpoint requests', async () => {
    const fetchSpy = mockJsonFetch([]);

    await api.getActiveSearchIndexJobs();
    await api.retrySearchIndexJob('job-1');

    expect(fetchSpy.mock.calls.map((call) => [String(call[0]), (call[1] as RequestInit | undefined)?.method ?? 'GET'])).toEqual([
      [expect.stringContaining('/api/search/index-jobs/active'), 'GET'],
      [expect.stringContaining('/api/search/index-jobs/job-1/retry'), 'POST'],
    ]);
  });
});
