import { expect, test } from './fixtures/p0App.mjs';
import { AI_FRESH_SERVER_NOW, installAiAutoExecutionMocks } from './fixtures/aiOperationMocks.mjs';
import {
  attachCheckpointScreenshot, expectNoHorizontalOverflow, openMealHistory,
  openModelSettings, stabilizeDarwinVisualGutter,
} from './fixtures/browserHelpers.mjs';

async function openAiConversation(page) {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'AI', exact: true }).first().click();
  const surface = page.locator(page.viewportSize().width < 768 ? '.ai-mobile-page' : '.ai-main-panel');
  await expect(surface).toBeVisible();
  await expect(surface.locator('.ai-operation-result-card')).toHaveCount(2);
  return surface;
}

function operationCard(surface, title) {
  return surface.locator('.ai-operation-result-card').filter({ hasText: title });
}

async function revertOwnOperation(surface, mocks) {
  const card = operationCard(surface, '自动收藏结果');
  await expect(card).toContainText('已自动执行');
  const revert = card.getByRole('button', { name: '撤销', exact: true });
  await revert.scrollIntoViewIfNeeded();
  await expect(revert).toBeInViewport();
  await revert.click();
  const completed = card.getByRole('button', { name: '已撤销', exact: true });
  await expect(completed).toBeVisible();
  await expect(completed).toBeFocused();
  await expect(completed).toHaveAttribute('aria-disabled', 'true');
  await expect(card.locator('.ai-query-card-eyebrow')).toHaveText('已撤销');
  await expect(surface.locator('.ai-operation-result-card')).toHaveCount(2);
  expect(mocks.revertRequestBodies).toHaveLength(1);
  expect(Object.keys(mocks.revertRequestBodies[0])).toEqual(['client_request_id']);
  expect(mocks.revertRequestBodies[0].client_request_id).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
  );
}

test.describe('P0 unauthenticated entry', () => {
  test.use({ authenticated: false });

  test('@p0 signs in and restores the family kitchen session', async ({ app, context }, testInfo) => {
    const { page } = app;

    await page.goto('/', { waitUntil: 'domcontentloaded' });

    await expect(page.getByRole('heading', { name: '登录家庭厨房' })).toBeVisible();
    await expect(page.getByRole('button', { name: '进入家庭厨房' })).toBeVisible();
    await expectNoHorizontalOverflow(page);
    await stabilizeDarwinVisualGutter(page);
    await expect(page.locator('.login-card')).toHaveScreenshot('login-card.png');
    await attachCheckpointScreenshot(page, testInfo, 'checkpoint-login-entry');

    const loginRequestPromise = page.waitForRequest(
      (request) => request.method() === 'POST' && new URL(request.url()).pathname === '/api/auth/login',
    );
    await page.getByLabel('用户名').fill('smoke');
    await page.getByLabel('密码').fill('p0-password');
    await page.getByRole('button', { name: '进入家庭厨房' }).click();

    const loginRequest = await loginRequestPromise;
    expect(loginRequest.postDataJSON()).toEqual({
      username: 'smoke',
      password: 'p0-password',
    });
    await expect(page.getByRole('heading', { name: '今天吃什么' })).toBeVisible();
    expect(await page.evaluate(() => localStorage.getItem('culina-access-token'))).toBeNull();
    const refreshCookie = (await context.cookies()).find((cookie) => cookie.name === 'culina-refresh');
    expect(refreshCookie).toMatchObject({
      httpOnly: true,
      path: '/api/auth',
      sameSite: 'Strict',
    });

    const refreshResponse = page.waitForResponse((response) =>
      response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/auth/refresh');
    await page.reload({ waitUntil: 'domcontentloaded' });
    expect((await refreshResponse).status()).toBe(200);
    await expect(page.getByRole('heading', { name: '今天吃什么' })).toBeVisible();
  });
});

test('@p0 Owner reverts an AI result and restores it after refresh', async ({ app, context }) => {
  const { page, unexpectedRequests } = app;
  await page.clock.install({ time: new Date(AI_FRESH_SERVER_NOW) });
  const mocks = await installAiAutoExecutionMocks(context, unexpectedRequests);
  const surface = await openAiConversation(page);
  await expect(page.getByRole('button', { name: 'AI 自动执行设置' })).toHaveCount(0);
  await expect(operationCard(surface, '人工确认结果').locator('.ai-operation-result-revert-note strong'))
    .toHaveText('可撤销至 19:00');
  await expectNoHorizontalOverflow(page);

  await test.step('撤销由 HTTP 结果替换原卡并保留焦点', () => revertOwnOperation(surface, mocks));
  await test.step('刷新恢复撤销结果与服务端截止时间', async () => {
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: 'AI', exact: true }).first().click();
    await expect(operationCard(surface, '自动收藏结果').locator('.ai-query-card-eyebrow')).toHaveText('已撤销');
    await expect(operationCard(surface, '人工确认结果').locator('.ai-operation-result-revert-note strong'))
      .toHaveText('可撤销至 19:00');
    expect(mocks.messagesRequestCount).toBeGreaterThanOrEqual(2);
  });
  await test.step('跨过撤销期限后关闭撤销入口', async () => {
    mocks.setHydratedServerNow('2026-08-24T11:00:00.001Z');
    await page.clock.fastForward(30 * 60 * 1000 + 1);
    const manual = operationCard(surface, '人工确认结果');
    await expect(manual).toContainText('撤销时间已过，可前往页面修改');
    await expect(manual.getByRole('button', { name: '撤销', exact: true })).toHaveCount(0);
    await expectNoHorizontalOverflow(page);
  });
});

test('@p0 navigates family surfaces and records a meal that survives refresh', async ({ app }, testInfo) => {
  const { page, requestedApiPaths, mealRecordRequests } = app;
  const isPhone = page.viewportSize().width < 768;

  await page.clock.setFixedTime(new Date('2026-07-12T09:00:00+08:00'));
  await page.goto('/', { waitUntil: 'domcontentloaded' });

  const homeSurface = page.locator(isPhone ? '.mobile-dashboard-page' : '.dashboard-page');
  await expect(homeSurface.getByRole('heading', { name: '今天吃什么' })).toBeVisible();
  await expect(homeSurface.getByRole('heading', { name: '今天需要处理什么' })).toBeVisible();
  await expect(homeSurface.getByRole('heading', { name: '家里发生了什么' })).toBeVisible();
  await expect
    .poll(() => requestedApiPaths.includes('/api/activity-highlights'))
    .toBe(true);
  expect(requestedApiPaths).not.toContain('/api/activity-logs');
  await expect(page.getByRole('button', { name: /查看通知.*需要处理/ })).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await stabilizeDarwinVisualGutter(page);
  await expect(page).toHaveScreenshot('family-home.png', { timeout: 15_000 });
  await attachCheckpointScreenshot(page, testInfo, 'checkpoint-family-home');

  await page.getByRole('button', { name: '吃什么' }).first().click();
  if (isPhone) {
    await expect(page.locator('.mobile-food-page')).toBeVisible();
    await expect(page.locator('.mobile-food-page').getByRole('heading', { name: '吃什么' })).toBeVisible();
  } else {
    await expect(page.getByText('食物库', { exact: true }).first()).toBeVisible();
  }

  await page.getByRole('button', { name: '食材' }).first().click();
  if (isPhone) {
    await expect(page.locator('.mobile-ingredient-page')).toBeVisible();
    await expect(page.locator('.mobile-ingredient-page').getByRole('heading', { name: '食材' })).toBeVisible();
  } else {
    await expect(page.getByText('管理家庭食材、库存和采购清单。', { exact: true })).toBeVisible();
  }
  await expectNoHorizontalOverflow(page);
  await attachCheckpointScreenshot(page, testInfo, 'checkpoint-ingredient-page');

  await openMealHistory(page, isPhone);
  await page.getByRole('button', { name: '记一餐', exact: true }).click();

  const mealComposer = page.locator('.meal-composer-modal');
  await expect(mealComposer).toBeVisible();
  await expect(mealComposer.getByRole('heading', { name: '确认时间' })).toBeVisible();
  await expect(mealComposer.getByRole('heading', { name: '添加食物' })).toBeVisible();
  await expect(mealComposer).toHaveScreenshot('meal-composer.png', { timeout: 15_000 });
  await attachCheckpointScreenshot(page, testInfo, 'checkpoint-meal-composer');

  const foodSearch = mealComposer.getByRole('searchbox', { name: '搜索食物' });
  await mealComposer.getByRole('radio', { name: '早餐', exact: true }).click();
  await foodSearch.fill('米饭');
  const searchResults = mealComposer.getByRole('listbox', { name: '食物搜索结果' });
  await expect(searchResults).toBeVisible();
  await searchResults.getByRole('option', { name: /^米饭 / }).click();
  await expect(mealComposer.getByRole('listitem').filter({ hasText: '米饭' })).toBeVisible();

  const isMealRecordRequest = (request) =>
    request.method() === 'POST' && new URL(request.url()).pathname === '/api/meal-logs/record';
  const [recordRequest, recordResponse] = await Promise.all([
    page.waitForRequest(isMealRecordRequest),
    page.waitForResponse(
      (response) => isMealRecordRequest(response.request()),
    ),
    mealComposer.getByRole('button', { name: '记下这餐' }).click(),
  ]);
  expect(recordResponse.ok()).toBe(true);
  const recordPayload = recordRequest.postDataJSON();
  expect(recordPayload).toMatchObject({
    date: '2026-07-12',
    target: { kind: 'new' },
  });
  expect(recordPayload.entries).toEqual(
    [{ food_id: 'food-rice', servings: 1 }],
  );
  expect(recordPayload.client_request_id).toEqual(expect.any(String));
  expect(recordPayload.meal_type).toBe('breakfast');

  await expect(mealComposer).toBeHidden();
  const recordResult = page.locator('.meal-record-result-bar:visible').first();
  await expect(recordResult).toBeVisible();
  await expect(recordResult.getByText('已记下', { exact: true })).toBeVisible();
  await expect(recordResult).toContainText('米饭');
  const rows = page.locator(isPhone ? '.mobile-log-record-row' : '.meal-log-record-row');
  await expect(rows.filter({ hasText: '米饭' })).toHaveCount(1);
  await expect(rows.filter({ hasText: '米饭' })).toContainText('早餐');
  expect(mealRecordRequests).toHaveLength(1);
  await expectNoHorizontalOverflow(page);

  await test.step('刷新后重新进入记录列表，新餐食仍存在且没有重复', async () => {
    await page.reload({ waitUntil: 'domcontentloaded' });
    await openMealHistory(page, isPhone);
    await expect(rows.filter({ hasText: '米饭' })).toHaveCount(1);
    await expect(rows.filter({ hasText: '米饭' })).toContainText('早餐');
    expect(mealRecordRequests).toHaveLength(1);
  });
});

test.describe('Member AI workspace', () => {
  test.use({ role: 'Member' });
  test('@p0 Member reads the conversation and reverts their own AI result', async ({ app, context }) => {
    const { page, unexpectedRequests, familyModelRequests } = app;
    await page.clock.install({ time: new Date(AI_FRESH_SERVER_NOW) });
    const mocks = await installAiAutoExecutionMocks(context, unexpectedRequests);
    const surface = await openAiConversation(page);
    await revertOwnOperation(surface, mocks);
    await expectNoHorizontalOverflow(page);
    expect(mocks.messagesRequestCount).toBeGreaterThan(0);
    expect(familyModelRequests, 'Member 不应请求 Owner 的模型配置').toEqual([]);
  });
});

test('@p0 family model settings save changes and retain test results across navigation', async ({ app }) => {
  const { page, familyModelRequests } = app;
  const isPhone = page.viewportSize().width < 768;
  await openModelSettings(page);

  await test.step('Escape 只关闭模型列表，设置页面仍可操作', async () => {
    const model = page.getByRole('combobox', { name: '模型名称', exact: true });
    await model.click();
    await expect(page.getByRole('listbox', { name: '模型名称选项' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('listbox', { name: '模型名称选项' })).toHaveCount(0);
    await expect(model).toBeVisible();
  });

  await test.step('修改输出长度后自动保存，再测试当前配置', async () => {
    const saved = page.waitForResponse((response) => response.request().method() === 'PUT'
      && new URL(response.url()).pathname === '/api/family/model-settings/draft');
    const tokens = page.getByLabel('最大回复长度（Token）', { exact: true });
    await tokens.fill('131072');
    await tokens.blur();
    const response = await saved;
    expect(response.status()).toBe(200);
    expect(response.request().postDataJSON().bindings).toEqual(expect.arrayContaining([
      expect.objectContaining({ capability: 'llm', variant_key: 'primary', max_output_tokens: 131072 }),
    ]));
    await expect(page.getByText('修改已保存', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: '测试功能', exact: true }).click();
    await expect(page.getByText('测试通过', { exact: true })).toBeVisible();
  });

  await test.step('切页返回后保留修改和测试结果，不重复调用模型', async () => {
    if (isPhone) await page.getByRole('button', { name: '返回服务概览' }).click();
    await page.getByRole('button', { name: /^模型价格/ }).click();
    await expect(page.getByText(/实际费用以服务商账单为准/)).toBeVisible();
    if (isPhone) await page.getByRole('button', { name: '返回服务概览' }).click();
    await page.getByRole('button', { name: /^功能设置/ }).click();
    await expect(page.getByText('测试通过', { exact: true })).toBeVisible();
    await expect(page.getByLabel('最大回复长度（Token）', { exact: true })).toHaveValue('131072');
    expect(familyModelRequests.filter((request) => request.pathname.endsWith('/capabilities/llm/test'))).toHaveLength(1);
    await expectNoHorizontalOverflow(page);
  });
});
