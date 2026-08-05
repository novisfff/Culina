import { expect, test } from './fixtures/p0App.mjs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

const MODEL_USAGE_VIEWPORTS = [
  { width: 360, height: 800 },
  { width: 375, height: 812 },
  { width: 390, height: 844 },
  { width: 430, height: 932 },
  { width: 768, height: 1024 },
  { width: 1024, height: 768 },
  { width: 1440, height: 900 },
];

async function expectNoHorizontalOverflow(page) {
  const overflow = await page.evaluate(
    () => Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - window.innerWidth,
  );
  expect(overflow, '模型用量页面不应产生横向溢出').toBeLessThanOrEqual(1);
}

async function saveVisualReviewScreenshot(page, filename) {
  const outputDirectory = process.env.MODEL_USAGE_VISUAL_REVIEW_DIR;
  if (!outputDirectory) return;

  const absoluteDirectory = path.resolve(outputDirectory);
  await mkdir(absoluteDirectory, { recursive: true });
  await page.screenshot({
    path: path.join(absoluteDirectory, filename),
    fullPage: true,
    animations: 'disabled',
  });
}

async function openModelUsage(page) {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  const mobileFamilyNavigation = page.locator('.mobile-bottom-nav:visible').getByRole('button', { name: '家庭' });
  const desktopFamilyNavigation = page.locator('.sidebar-nav:visible').getByRole('button', { name: '家庭' });
  await mobileFamilyNavigation.or(desktopFamilyNavigation).click();
  await page.locator('.family-model-usage-entry:visible, .mobile-family-model-usage-entry:visible').first().click();
}

for (const viewport of MODEL_USAGE_VIEWPORTS) {
  test(`@p0 @model-usage-${viewport.width}x${viewport.height} owner model usage stays usable at ${viewport.width}x${viewport.height}`, async ({ app }) => {
    const { page } = app;
    expect(page.viewportSize()).toEqual(viewport);

    await openModelUsage(page);

    await expect(page.getByRole('heading', { name: '家庭模型用量' })).toBeVisible();
    await expectNoHorizontalOverflow(page);
    await saveVisualReviewScreenshot(page, `${viewport.width}x${viewport.height}-owner.png`);
  });
}

test('@p0 @model-usage-390x844 long provider and model names wrap without horizontal overflow', async ({ app }) => {
  const { page } = app;
  await openModelUsage(page);

  await page.getByLabel('统计维度').selectOption('provider_model');
  await expect(page.getByText(/gpt-smoke-regional-routing-snapshot-2026-08-05-with-a-very-long-model-name/)).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await saveVisualReviewScreenshot(page, '390x844-long-model.png');
});

test('@p0 @model-usage-1440x900 owner switches between family and personal model usage', async ({ app }) => {
  const { page, requestedApiPaths } = app;
  await openModelUsage(page);

  await page.getByRole('button', { name: '我的' }).click();

  await expect(page.getByRole('heading', { name: '我的模型用量' })).toBeVisible();
  await expect.poll(() => requestedApiPaths.some((path) => path === '/api/model-usage/me/overview')).toBe(true);
  await expect(page.getByText('家庭月预算', { exact: true })).toHaveCount(0);

  await page.getByRole('button', { name: '家庭' }).last().click();
  await expect(page.getByRole('heading', { name: '家庭模型用量' })).toBeVisible();
});

test('@p0 @model-usage-1440x900 owner alert deep links to its period and can be dismissed', async ({ app }) => {
  const { page } = app;
  await page.goto('/', { waitUntil: 'domcontentloaded' });

  await page.getByRole('button', { name: /查看通知/ }).first().click();
  const alertOpen = page.getByRole('button', { name: '查看模型用量需要处理' });
  await expect(alertOpen).toBeVisible();
  const seenRequest = page.waitForRequest((request) => (
    request.method() === 'POST'
    && new URL(request.url()).pathname === '/api/model-usage/alerts/alert-model-usage-p0/seen'
  ));
  await alertOpen.click();
  await seenRequest;

  await expect(page.getByRole('heading', { name: '家庭模型用量' })).toBeVisible();
  await expect(page.getByLabel('选择账期')).toHaveValue('2026-06');

  await page.getByRole('button', { name: /查看通知/ }).first().click();
  const dismissRequest = page.waitForRequest((request) => (
    request.method() === 'POST'
    && new URL(request.url()).pathname === '/api/model-usage/alerts/alert-model-usage-p0/dismiss'
  ));
  await page.getByRole('button', { name: '清除模型用量需要处理通知' }).click();
  await dismissRequest;
  await expect(page.getByRole('button', { name: '查看模型用量需要处理' })).toHaveCount(0);
});

test('@p0 @model-usage-1440x900 owner sees hard-limit in-flight disclosure and saves a policy', async ({ app }) => {
  const { page } = app;
  await openModelUsage(page);

  await page.getByRole('button', { name: '预算设置' }).click();
  await expect(page.getByRole('heading', { name: '模型预算设置' })).toBeVisible();
  await expect(page.getByText(/尚未取得首次持久化发送授权的普通预留会按新策略重新核验/)).toBeVisible();

  const saveRequest = page.waitForRequest((request) => (
    request.method() === 'PUT'
    && new URL(request.url()).pathname === '/api/model-usage/family/policy'
  ));
  await page.getByRole('button', { name: '保存设置' }).click();
  await saveRequest;
  await expect(page.getByRole('heading', { name: '家庭模型用量' })).toBeVisible();
});

test.describe('@p0 @model-usage-390x844 ordinary member model-usage privacy', () => {
  test.use({ modelUsageScenario: 'member' });

  test('shows only personal usage and never requests the family financial views', async ({ app }) => {
    const { page, requestedApiPaths } = app;
    await openModelUsage(page);

    await expect(page.getByRole('heading', { name: '我的模型用量' })).toBeVisible();
    await expect(page.getByRole('button', { name: '预算设置' })).toHaveCount(0);
    await expect(page.locator('.model-usage-scope-toggle:visible')).toHaveCount(0);
    await expect(page.getByText('家庭月预算', { exact: true })).toHaveCount(0);
    await expect(page.getByText('￥80.00', { exact: true })).toHaveCount(0);
    expect(requestedApiPaths.some((path) => path.startsWith('/api/model-usage/family/'))).toBe(false);
    expect(requestedApiPaths.some((path) => path.startsWith('/api/model-usage/me/'))).toBe(true);
  });
});

test.describe('@p0 @model-usage-1440x900 owner policy conflict recovery', () => {
  test.use({ modelUsageScenario: 'owner-conflict' });

  test('retains the draft, reviews the current version, and re-saves intentionally', async ({ app }) => {
    const { page } = app;
    await openModelUsage(page);
    await page.getByRole('button', { name: '预算设置' }).click();

    await page.getByRole('button', { name: '保存设置' }).click();
    await expect(page.getByRole('heading', { name: '预算设置已被更新' })).toBeVisible();
    await expect(page.getByText('当前版本：5')).toBeVisible();

    await page.getByRole('button', { name: '重新应用保留的修改' }).click();
    const retryRequest = page.waitForRequest((request) => (
      request.method() === 'PUT'
      && new URL(request.url()).pathname === '/api/model-usage/family/policy'
    ));
    await page.getByRole('button', { name: '保存设置' }).click();
    const request = await retryRequest;
    expect(request.postDataJSON()).toMatchObject({ base_version_number: 5 });
    await expect(page.getByRole('heading', { name: '家庭模型用量' })).toBeVisible();
  });
});

test('@p0 @model-usage-1440x900 owner keeps the last model-usage data visible during an offline detail refresh and recovers', async ({ app, context }) => {
  const { page } = app;
  await openModelUsage(page);
  await expect(page.getByRole('heading', { name: '家庭模型用量' })).toBeVisible();

  const failingBreakdown = /\/api\/model-usage\/family\/breakdown\?period=2026-07&group_by=provider_model$/;
  await page.route(failingBreakdown, async (route) => {
    await route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ detail: { code: 'model_usage_query_unavailable' } }),
    });
  });
  await context.setOffline(true);
  await page.getByLabel('统计维度').selectOption('provider_model');

  await expect(page.getByText('当前离线，正在显示已缓存的数据。')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText('家庭月预算', { exact: true })).toBeVisible();

  await context.setOffline(false);
  await page.unroute(failingBreakdown);
  await page.getByLabel('统计维度').selectOption('capability');
  await expect(page.getByText('当前离线，正在显示已缓存的数据。')).toHaveCount(0, { timeout: 15_000 });
});

test('@p0 @model-usage-390x844 model usage keeps keyboard controls and accessible names at reduced motion and 200% text zoom', async ({ app }) => {
  const { page } = app;
  expect(page.viewportSize()).toEqual({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await openModelUsage(page);

  const budgetSettings = page.getByRole('button', { name: '预算设置' });
  await expect(budgetSettings).toBeVisible();
  await expect(page.getByLabel('选择账期')).toBeVisible();
  await expect(page.getByLabel('统计维度')).toBeVisible();
  expect(await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches)).toBe(true);

  await page.evaluate(() => {
    document.documentElement.style.fontSize = '200%';
  });
  await expectNoHorizontalOverflow(page);

  await budgetSettings.focus();
  await expect(budgetSettings).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: '模型预算设置' })).toBeVisible();
});
