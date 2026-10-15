import { expect, test as base } from '@playwright/test';
import { installApiMocks } from './apiMocks.mjs';

export const test = base.extend({
  authenticated: [true, { option: true }],
  role: ['Owner', { option: true }],
  familyModelScenario: ['configured', { option: true }],
  app: async ({ authenticated, context, familyModelScenario, role, page }, use) => {
    const consoleErrors = [];
    const pageErrors = [];
    const requestedApiPaths = [];
    const familyModelRequests = [];
    const unexpectedRequests = [];
    const mealRecordRequests = [];
    const httpErrors = [];
    const expectedHttpErrors = [];

    await installApiMocks(context, unexpectedRequests, {
      role,
      familyModelScenario,
      authenticated,
      requestedApiPaths,
      familyModelRequests,
      mealRecordRequests,
    });

    if (authenticated) {
      await context.addCookies([{
        name: 'culina-refresh',
        value: 'smoke-refresh-token',
        domain: '127.0.0.1',
        path: '/api/auth',
        httpOnly: true,
        secure: false,
        sameSite: 'Strict',
      }]);
      await context.addInitScript(() => {
        localStorage.setItem(
          'culina-navigation-v2',
          JSON.stringify({
            version: 2,
            primaryTab: 'home',
            eatBaseView: 'discover',
            discoverSection: 'all',
          }),
        );
      });
    }

    page.on('pageerror', (error) => {
      pageErrors.push(error.message);
    });
    page.on('console', (message) => {
      if (message.type() === 'error') {
        const url = message.location().url;
        // The initial unauthenticated bootstrap deliberately returns 401.
        if (!authenticated && message.text().startsWith('Failed to load resource')
          && url && new URL(url).pathname === '/api/auth/refresh') return;
        if (message.text().startsWith('Failed to load resource') && url
          && expectedHttpErrors.some((entry) => entry.path === new URL(url).pathname && message.text().includes(String(entry.status)))) return;
        consoleErrors.push(message.text());
      }
    });
    page.on('response', (response) => {
      if (response.status() < 400) return;
      if (!authenticated && response.status() === 401
        && new URL(response.url()).pathname === '/api/auth/refresh') return;
      if (expectedHttpErrors.some((entry) => entry.path === new URL(response.url()).pathname && entry.status === response.status())) return;
      httpErrors.push(`${response.status()} ${response.request().method()} ${response.url()}`);
    });

    await use({ page, requestedApiPaths, familyModelRequests, mealRecordRequests, unexpectedRequests, expectedHttpErrors });

    expect(unexpectedRequests, 'P0 页面不应发出未 mock 的 API 请求').toEqual([]);
    expect(httpErrors, 'P0 页面不应收到非预期的 HTTP 错误').toEqual([]);
    expect(pageErrors, 'P0 页面不应产生未捕获的运行时错误').toEqual([]);
    expect(consoleErrors, 'P0 页面不应产生浏览器 console error').toEqual([]);
  },
});

export { expect };
