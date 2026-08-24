import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from './client';
import {
  ApiError,
  clearAuthenticatedSession,
  getAccessToken,
  isApiError,
  purgeLegacyAccessToken,
  refreshAuthSession,
  request,
  setAccessToken,
  setAuthenticatedSession,
  subscribeAuthSession,
} from './request';
import type { LoginResponse } from './types';

const authPayload: LoginResponse = {
  access_token: 'fresh-access-token',
  user: {
    id: 'user-a',
    username: 'owner',
    display_name: 'Owner',
    avatar_seed: 'Owner',
  },
  membership: {
    id: 'membership-a',
    family_id: 'family-a',
    user_id: 'user-a',
    role: 'Owner',
    status: 'active',
  },
  family: {
    id: 'family-a',
    name: '测试家庭',
    motto: '',
    location: '',
    food_preferences: [],
    food_avoidances: [],
    created_at: '2026-08-24T00:00:00Z',
    updated_at: '2026-08-24T00:00:00Z',
    ai_recommendations: [],
  },
};

const otherAuthPayload: LoginResponse = {
  ...authPayload,
  access_token: 'other-access-token',
  user: {
    ...authPayload.user,
    id: 'user-b',
    username: 'other-owner',
    display_name: 'Other Owner',
  },
  membership: {
    ...authPayload.membership,
    id: 'membership-b',
    family_id: 'family-b',
    user_id: 'user-b',
  },
  family: {
    ...authPayload.family,
    id: 'family-b',
    name: '另一个家庭',
  },
};

afterEach(() => {
  vi.unstubAllGlobals();
  setAccessToken(null);
});

describe('api client errors', () => {
  it('keeps access tokens in memory without writing localStorage', () => {
    setAccessToken('short-lived-access-token');

    expect(getAccessToken()).toBe('short-lived-access-token');
    expect(localStorage.getItem('culina-access-token')).toBeNull();
  });

  it('removes the legacy persisted access token during migration', () => {
    localStorage.setItem('culina-access-token', 'legacy-seven-day-token');

    purgeLegacyAccessToken();

    expect(localStorage.getItem('culina-access-token')).toBeNull();
  });

  it('uses one refresh for concurrent unauthorized requests and retries each once', async () => {
    setAccessToken('expired-access-token');
    const sessionChanges: Array<LoginResponse | null> = [];
    const unsubscribe = subscribeAuthSession((payload) => sessionChanges.push(payload));
    const fetchSpy = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path.endsWith('/api/auth/refresh')) {
        return new Response(JSON.stringify(authPayload), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      const authorization = new Headers(init?.headers).get('Authorization');
      if (authorization === 'Bearer expired-access-token') {
        return new Response(JSON.stringify({ detail: '登录已过期' }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchSpy);

    try {
      await expect(Promise.all([
        request<{ ok: boolean }>('/api/foods'),
        request<{ ok: boolean }>('/api/ingredients'),
      ])).resolves.toEqual([{ ok: true }, { ok: true }]);
    } finally {
      unsubscribe();
    }

    expect(fetchSpy.mock.calls.filter(([input]) => String(input).endsWith('/api/auth/refresh'))).toHaveLength(1);
    expect(fetchSpy.mock.calls.every(([, init]) => init?.credentials === 'include')).toBe(true);
    expect(getAccessToken()).toBe('fresh-access-token');
    expect(sessionChanges).toEqual([authPayload]);
    const retriedCalls = fetchSpy.mock.calls.filter(([, init]) => (
      new Headers(init?.headers).get('Authorization') === 'Bearer fresh-access-token'
    ));
    expect(retriedCalls).toHaveLength(2);
  });

  it('does not rotate refresh again when a late 401 used an older access token', async () => {
    setAuthenticatedSession({
      ...authPayload,
      access_token: 'expired-access-token',
    });
    let releaseLateResponse: (() => void) | undefined;
    const lateResponse = new Promise<void>((resolve) => {
      releaseLateResponse = resolve;
    });
    const fetchSpy = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path.endsWith('/api/auth/refresh')) {
        return new Response(JSON.stringify(authPayload), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      const authorization = new Headers(init?.headers).get('Authorization');
      if (authorization === 'Bearer expired-access-token') {
        if (path.endsWith('/api/ingredients')) await lateResponse;
        return new Response(null, { status: 401 });
      }
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchSpy);

    const firstRequest = request<{ ok: boolean }>('/api/foods');
    const lateRequest = request<{ ok: boolean }>('/api/ingredients');
    await expect(firstRequest).resolves.toEqual({ ok: true });
    releaseLateResponse?.();
    await expect(lateRequest).resolves.toEqual({ ok: true });

    expect(fetchSpy.mock.calls.filter(([input]) => String(input).endsWith('/api/auth/refresh')))
      .toHaveLength(1);
  });

  it('rejects a late unauthenticated response without clearing a newer session', async () => {
    let releaseResponse: (() => void) | undefined;
    const responseGate = new Promise<void>((resolve) => {
      releaseResponse = resolve;
    });
    vi.stubGlobal('fetch', vi.fn(async () => {
      await responseGate;
      return new Response(null, { status: 401 });
    }));

    const staleRequest = request('/api/foods');
    setAuthenticatedSession(authPayload);
    releaseResponse?.();

    await expect(staleRequest).rejects.toThrow('认证身份已切换');
    expect(getAccessToken()).toBe('fresh-access-token');
  });

  it('does not restore an older refresh when a newer session wins the race', async () => {
    let releaseRefresh: (() => void) | undefined;
    const refreshGate = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });
    vi.stubGlobal('fetch', vi.fn(async () => {
      await refreshGate;
      return new Response(JSON.stringify(authPayload), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }));

    const staleRefresh = refreshAuthSession();
    clearAuthenticatedSession();
    setAuthenticatedSession({ ...authPayload, access_token: 'newer-access-token' });
    releaseRefresh?.();

    await expect(staleRefresh).rejects.toThrow('认证状态已更新');
    expect(getAccessToken()).toBe('newer-access-token');
  });

  it('rejects a successful response that belongs to a previous identity', async () => {
    let releaseResponse: (() => void) | undefined;
    const responseGate = new Promise<void>((resolve) => {
      releaseResponse = resolve;
    });
    setAuthenticatedSession(authPayload);
    vi.stubGlobal('fetch', vi.fn(async () => {
      await responseGate;
      return new Response(JSON.stringify({ private: 'family-a' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }));

    const staleRequest = request('/api/private-family-data');
    setAuthenticatedSession(otherAuthPayload);
    releaseResponse?.();

    await expect(staleRequest).rejects.toThrow('认证身份已切换');
    expect(getAccessToken()).toBe('other-access-token');
  });

  it('rejects delayed response headers after logout and login as the same identity', async () => {
    let releaseResponse: (() => void) | undefined;
    const responseGate = new Promise<void>((resolve) => {
      releaseResponse = resolve;
    });
    const fetchSpy = vi.fn(async () => {
      await responseGate;
      return new Response(JSON.stringify({ private: 'old-session-data' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    setAuthenticatedSession(authPayload);
    vi.stubGlobal('fetch', fetchSpy);

    const staleRequest = request('/api/private-family-data');
    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledOnce());
    clearAuthenticatedSession();
    setAuthenticatedSession({
      ...authPayload,
      access_token: 'new-login-access-token',
    });
    releaseResponse?.();

    await expect(staleRequest).rejects.toThrow('认证身份已切换');
    expect(getAccessToken()).toBe('new-login-access-token');
  });

  it('rejects a response body that completes after the authenticated identity changes', async () => {
    let bodyController: ReadableStreamDefaultController<Uint8Array> | undefined;
    const delayedBody = new ReadableStream<Uint8Array>({
      start(controller) {
        bodyController = controller;
      },
    });
    const fetchSpy = vi.fn(async () => new Response(delayedBody, {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    setAuthenticatedSession(authPayload);
    vi.stubGlobal('fetch', fetchSpy);

    const staleRequest = request('/api/private-family-data');
    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledOnce());
    await Promise.resolve();
    await Promise.resolve();
    setAuthenticatedSession(otherAuthPayload);
    bodyController?.enqueue(new TextEncoder().encode(JSON.stringify({ private: 'family-a' })));
    bodyController?.close();

    await expect(staleRequest).rejects.toThrow('认证身份已切换');
    expect(getAccessToken()).toBe('other-access-token');
  });

  it('keeps reading a response when only the same identity access token rotates', async () => {
    let bodyController: ReadableStreamDefaultController<Uint8Array> | undefined;
    const delayedBody = new ReadableStream<Uint8Array>({
      start(controller) {
        bodyController = controller;
      },
    });
    const fetchSpy = vi.fn(async () => new Response(delayedBody, {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    setAuthenticatedSession(authPayload);
    vi.stubGlobal('fetch', fetchSpy);

    const requestInFlight = request<{ private: string }>('/api/private-family-data');
    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledOnce());
    await Promise.resolve();
    await Promise.resolve();
    setAuthenticatedSession({
      ...authPayload,
      access_token: 'rotated-access-token',
    });
    bodyController?.enqueue(new TextEncoder().encode(JSON.stringify({ private: 'family-a' })));
    bodyController?.close();

    await expect(requestInFlight).resolves.toEqual({ private: 'family-a' });
    expect(getAccessToken()).toBe('rotated-access-token');
  });

  it('rejects a response body after the low-level token setter clears its identity', async () => {
    let bodyController: ReadableStreamDefaultController<Uint8Array> | undefined;
    const delayedBody = new ReadableStream<Uint8Array>({
      start(controller) {
        bodyController = controller;
      },
    });
    const fetchSpy = vi.fn(async () => new Response(delayedBody, {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    setAuthenticatedSession(authPayload);
    vi.stubGlobal('fetch', fetchSpy);

    const staleRequest = request('/api/private-family-data');
    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledOnce());
    await Promise.resolve();
    await Promise.resolve();
    setAccessToken(null);
    bodyController?.enqueue(new TextEncoder().encode(JSON.stringify({ private: 'family-a' })));
    bodyController?.close();

    await expect(staleRequest).rejects.toThrow('认证身份已切换');
    expect(getAccessToken()).toBeNull();
  });

  it('serializes every authentication cookie writer behind one browser lock', async () => {
    let lockTail = Promise.resolve<unknown>(undefined);
    const lockRequest = vi.fn((
      _name: string,
      _options: LockOptions,
      callback: (lock: Lock | null) => Promise<unknown>,
    ) => {
      const result = lockTail.then(() => callback(null));
      lockTail = result.catch(() => undefined);
      return result;
    });
    vi.stubGlobal('navigator', { locks: { request: lockRequest } });

    const started: string[] = [];
    let releaseRefresh: (() => void) | undefined;
    const refreshGate = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      started.push(path);
      if (path.endsWith('/api/auth/refresh')) {
        await refreshGate;
        return new Response(JSON.stringify(authPayload), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (path.endsWith('/api/auth/login')) {
        return new Response(JSON.stringify(otherAuthPayload), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(null, { status: 204 });
    }));

    const refresh = api.refresh();
    await vi.waitFor(() => expect(started).toEqual(['/api/auth/refresh']));
    const login = api.login('other-owner', 'OtherPass123');
    const logout = api.logout();
    const password = api.updatePassword({
      current_password: 'OtherPass123',
      new_password: 'ChangedPass456',
    });

    try {
      await Promise.resolve();
      expect(started).toEqual(['/api/auth/refresh']);
    } finally {
      releaseRefresh?.();
      await Promise.allSettled([refresh, login, logout, password]);
    }

    expect(started).toEqual([
      '/api/auth/refresh',
      '/api/auth/login',
      '/api/auth/logout',
      '/api/auth/password',
    ]);
    expect(lockRequest).toHaveBeenCalledTimes(4);
    expect(new Set(lockRequest.mock.calls.map(([name]) => name))).toEqual(
      new Set(['culina-auth-cookie-v1']),
    );
  });

  it('does not deadlock when a held cookie lock needs a refresh queued behind it', async () => {
    setAccessToken('expired-access-token');
    let lockTail = Promise.resolve<unknown>(undefined);
    const lockRequest = vi.fn((
      _name: string,
      _options: LockOptions,
      callback: (lock: Lock | null) => Promise<unknown>,
    ) => {
      const result = lockTail.then(() => callback(null));
      lockTail = result.catch(() => undefined);
      return result;
    });
    vi.stubGlobal('navigator', { locks: { request: lockRequest } });

    let markPasswordStarted: (() => void) | undefined;
    const passwordStarted = new Promise<void>((resolve) => {
      markPasswordStarted = resolve;
    });
    let releasePasswordUnauthorized: (() => void) | undefined;
    const passwordUnauthorizedGate = new Promise<void>((resolve) => {
      releasePasswordUnauthorized = resolve;
    });
    const started: string[] = [];
    let passwordAttempts = 0;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      started.push(path);
      if (path.endsWith('/api/auth/password')) {
        passwordAttempts += 1;
        if (passwordAttempts === 1) {
          markPasswordStarted?.();
          await passwordUnauthorizedGate;
          return new Response(JSON.stringify({ detail: '登录已过期' }), {
            status: 401,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return new Response(null, { status: 204 });
      }
      if (path.endsWith('/api/auth/refresh')) {
        return new Response(JSON.stringify(authPayload), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      throw new Error(`Unexpected request: ${path}`);
    }));

    const password = api.updatePassword({
      current_password: 'OldPass123',
      new_password: 'ChangedPass456',
    });
    await passwordStarted;
    const queuedRefresh = refreshAuthSession();
    const settlement = Promise.allSettled([password, queuedRefresh]);
    releasePasswordUnauthorized?.();

    await vi.waitFor(() => {
      expect(started).toContain('/api/auth/refresh');
    });
    const [passwordResult, queuedRefreshResult] = await settlement;

    expect(passwordResult.status).toBe('fulfilled');
    expect(queuedRefreshResult.status).toBe('rejected');
    expect(started).toEqual([
      '/api/auth/password',
      '/api/auth/refresh',
      '/api/auth/password',
    ]);
    expect(getAccessToken()).toBeNull();
  });

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
