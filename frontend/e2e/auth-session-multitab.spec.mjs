import { expect, test } from '@playwright/test';

import { installApiMocks } from './fixtures/apiMocks.mjs';

const now = '2026-08-24T00:00:00Z';
const authResponse = {
  access_token: 'browser-shared-access-token',
  user: {
    id: 'user-smoke',
    username: 'smoke',
    display_name: 'Smoke User',
    email: 'smoke@example.com',
    phone: null,
    avatar_seed: 'Smoke User',
    avatar_image: null,
  },
  membership: {
    id: 'membership-smoke',
    family_id: 'family-smoke',
    user_id: 'user-smoke',
    role: 'Owner',
    status: 'active',
  },
  family: {
    id: 'family-smoke',
    name: 'Smoke 家庭厨房',
    motto: '多标签认证测试',
    location: '上海',
    food_preferences: [],
    food_avoidances: [],
    image: null,
    created_at: now,
    updated_at: now,
    ai_recommendations: [],
  },
};

test('serializes refresh across tabs and keeps both sessions synchronized @p0', async ({
  context,
}) => {
  const unexpectedRequests = [];
  await installApiMocks(context, unexpectedRequests, { authenticated: true });
  await context.addCookies([{
    name: 'culina-refresh',
    value: 'browser-shared-refresh-token',
    domain: '127.0.0.1',
    path: '/api/auth',
    httpOnly: true,
    secure: false,
    sameSite: 'Strict',
  }]);

  let refreshRequests = 0;
  let releaseFirstRefresh;
  const firstRefreshGate = new Promise((resolve) => {
    releaseFirstRefresh = resolve;
  });
  await context.route('**/api/auth/refresh', async (route) => {
    refreshRequests += 1;
    if (refreshRequests === 1) {
      await firstRefreshGate;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: {
        'Set-Cookie': 'culina-refresh=browser-shared-refresh-2; Path=/api/auth; HttpOnly; SameSite=Strict',
      },
      body: JSON.stringify(authResponse),
    });
  });

  const firstPage = await context.newPage();
  const secondPage = await context.newPage();
  await firstPage.goto('/');
  await expect.poll(() => refreshRequests).toBe(1);

  await secondPage.goto('/');
  await secondPage.waitForTimeout(300);
  expect(refreshRequests).toBe(1);

  releaseFirstRefresh();
  await expect(firstPage.getByText('Smoke User').first()).toBeVisible();
  await expect(secondPage.getByText('Smoke User').first()).toBeVisible();
  expect(refreshRequests).toBe(2);
  expect(unexpectedRequests).toEqual([]);
});
