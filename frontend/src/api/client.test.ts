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
  it('sends food and ingredient search pagination parameters', async () => {
    const fetchSpy = vi.fn(async (_input: RequestInfo | URL) => new Response(JSON.stringify([]), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchSpy);

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
    const fetchSpy = vi.fn(async (_input: RequestInfo | URL) => new Response(JSON.stringify({
      items: [],
      total: 0,
      query: '清淡晚饭',
      search_mode: 'hybrid',
      degraded: false,
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchSpy);

    await api.search({ q: '清淡晚饭', scopes: ['recipe', 'food'], limit: 10, offset: 5 });

    expect(String(fetchSpy.mock.calls[0]?.[0])).toContain(
      '/api/search?q=%E6%B8%85%E6%B7%A1%E6%99%9A%E9%A5%AD&scopes=recipe%2Cfood&limit=10&offset=5'
    );
  });
});
