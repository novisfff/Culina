import { expect, test as base } from '@playwright/test';
import { installApiMocks } from './apiMocks.mjs';

export const test = base.extend({
  authenticated: [true, { option: true }],
  modelUsageScenario: ['owner', { option: true }],
  familyModelScenario: ['configured', { option: true }],
  app: async ({ authenticated, context, familyModelScenario, modelUsageScenario, page }, use) => {
    const consoleErrors = [];
    const pageErrors = [];
    const requestedApiPaths = [];
    const familyModelRequests = [];
    const unexpectedRequests = [];

    await installApiMocks(context, unexpectedRequests, {
      modelUsageScenario,
      familyModelScenario,
      authenticated,
      requestedApiPaths,
      familyModelRequests,
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
        consoleErrors.push(message.text());
      }
    });

    await use({ page, requestedApiPaths, familyModelRequests });

    const relevantConsoleErrors = consoleErrors.filter(
      (message) => !message.includes('Failed to load resource'),
    );
    expect(unexpectedRequests, 'P0 页面不应发出未 mock 的 API 请求').toEqual([]);
    expect(pageErrors, 'P0 页面不应产生未捕获的运行时错误').toEqual([]);
    expect(relevantConsoleErrors, 'P0 页面不应产生浏览器 console error').toEqual([]);
  },
});

export { expect };
