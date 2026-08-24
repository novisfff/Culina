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

function authResponseFor(identity, displayName) {
  return {
    ...authResponse,
    access_token: `${identity}-access-token`,
    user: {
      ...authResponse.user,
      id: `${identity}-user`,
      username: `${identity}-owner`,
      display_name: displayName,
      avatar_seed: displayName,
    },
    membership: {
      ...authResponse.membership,
      id: `${identity}-membership`,
      family_id: `${identity}-family`,
      user_id: `${identity}-user`,
    },
    family: {
      ...authResponse.family,
      id: `${identity}-family`,
      name: `${displayName}的家庭`,
    },
  };
}

test('deduplicates refresh across tabs and keeps both sessions synchronized @p0', async ({
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
  expect(refreshRequests).toBe(1);
  expect(unexpectedRequests).toEqual([]);
});

test('applies the previous tab identity before a later login writes a new cookie @p0', async ({
  context,
}) => {
  const unexpectedRequests = [];
  await installApiMocks(context, unexpectedRequests, { authenticated: false });
  const previousAuth = authResponseFor('previous', '前序账号');
  const laterAuth = authResponseFor('later', '后序账号');
  let laterLoginRequests = 0;
  let releaseLaterLogin;
  const laterLoginGate = new Promise((resolve) => {
    releaseLaterLogin = resolve;
  });
  await context.route('**/api/auth/login', async (route) => {
    const payload = route.request().postDataJSON();
    const isLaterLogin = payload.username === laterAuth.user.username;
    if (isLaterLogin) {
      laterLoginRequests += 1;
      await laterLoginGate;
    }
    const response = isLaterLogin ? laterAuth : previousAuth;
    const cookie = isLaterLogin ? 'later-refresh-cookie' : 'previous-refresh-cookie';
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: {
        'Set-Cookie': `culina-refresh=${cookie}; Path=/api/auth; HttpOnly; SameSite=Strict`,
      },
      body: JSON.stringify(response),
    });
  });
  await context.route('**/api/auth/me', async (route) => {
    const cookie = route.request().headers().cookie ?? '';
    const response = cookie.includes('later-refresh-cookie') ? laterAuth : previousAuth;
    const { access_token: _accessToken, ...snapshot } = response;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(snapshot),
    });
  });

  const firstPage = await context.newPage();
  const secondPage = await context.newPage();
  await secondPage.addInitScript(() => {
    const NativeBroadcastChannel = window.BroadcastChannel;
    const gate = { holding: false, pending: [] };
    class GatedBroadcastChannel extends NativeBroadcastChannel {
      addEventListener(type, listener, options) {
        if (type !== 'message') {
          return super.addEventListener(type, listener, options);
        }
        return super.addEventListener(type, (event) => {
          const deliver = () => {
            if (typeof listener === 'function') {
              listener.call(this, event);
            } else {
              listener.handleEvent(event);
            }
          };
          if (this.name === 'culina-auth-transition-v1' && gate.holding) {
            gate.pending.push(deliver);
            return;
          }
          deliver();
        }, options);
      }
    }
    Object.defineProperty(window, 'BroadcastChannel', {
      configurable: true,
      value: GatedBroadcastChannel,
    });
    window.__holdAuthTransitions = () => {
      gate.holding = true;
    };
    window.__pendingAuthTransitions = () => gate.pending.length;
    window.__releaseAuthTransitions = () => {
      gate.holding = false;
      const pending = gate.pending.splice(0);
      pending.forEach((deliver) => deliver());
    };
  });

  await Promise.all([firstPage.goto('/'), secondPage.goto('/')]);
  await expect(firstPage.getByRole('heading', { name: '登录家庭厨房' })).toBeVisible();
  await expect(secondPage.getByRole('heading', { name: '登录家庭厨房' })).toBeVisible();
  await firstPage.evaluate(() => {
    window.__observedAuthTransitions = [];
    window.__authTransitionObserver = new BroadcastChannel('culina-auth-transition-v1');
    window.__authTransitionObserver.addEventListener('message', (event) => {
      window.__observedAuthTransitions.push(event.data);
    });
  });
  await secondPage.evaluate(() => window.__holdAuthTransitions());

  await firstPage.getByLabel('用户名').fill(previousAuth.user.username);
  await firstPage.getByLabel('密码').fill('PreviousPass123');
  await firstPage.getByRole('button', { name: '进入家庭厨房' }).click();
  await expect(firstPage.getByText(previousAuth.user.display_name).first()).toBeVisible();
  await expect.poll(() => secondPage.evaluate(() => window.__pendingAuthTransitions()))
    .toBeGreaterThan(0);

  await secondPage.getByLabel('用户名').fill(laterAuth.user.username);
  await secondPage.getByLabel('密码').fill('LaterPass123');
  await secondPage.getByRole('button', { name: '进入家庭厨房' }).click();
  await expect.poll(() => secondPage.evaluate(async () => {
    const snapshot = await navigator.locks.query();
    return snapshot.held?.some((lock) => lock.name === 'culina-auth-cookie-v1') ?? false;
  })).toBe(true);
  expect(laterLoginRequests).toBe(0);

  await secondPage.evaluate(() => window.__releaseAuthTransitions());
  await expect.poll(() => laterLoginRequests).toBe(1);
  releaseLaterLogin();

  await expect(secondPage.getByText(laterAuth.user.display_name).first()).toBeVisible();
  await expect.poll(() => firstPage.evaluate(() => window.__observedAuthTransitions))
    .toContainEqual(expect.objectContaining({ payload: laterAuth }));
  await expect.poll(async () => {
    const cookie = (await context.cookies()).find((item) => item.name === 'culina-refresh');
    return cookie?.value;
  }).toBe('later-refresh-cookie');
  expect(unexpectedRequests).toEqual([]);
});
