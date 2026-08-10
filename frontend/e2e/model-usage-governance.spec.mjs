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
    await expect(page.getByRole('heading', { name: '每日费用趋势' })).toBeVisible();
    await expect(page.getByRole('heading', { name: '费用细分' })).toBeVisible();
    await expect(page.getByText('按日期', { exact: true }).or(page.getByText('每日', { exact: true }))).toBeVisible();
    await expectNoHorizontalOverflow(page);
    await saveVisualReviewScreenshot(page, `${viewport.width}x${viewport.height}-owner.png`);
  });
}

test('@p0 @model-usage-390x844 long provider and model names wrap without horizontal overflow', async ({ app }) => {
  const { page } = app;
  await openModelUsage(page);

  await page.getByLabel('细分方式').selectOption('provider_model');
  await expect(page.getByText(/gpt-smoke-regional-routing-snapshot-2026-08-05-with-a-very-long-model-name/)).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await saveVisualReviewScreenshot(page, '390x844-long-model.png');
});

test('@p0 @model-usage-390x844 @model-usage-1440x900 request logs use a normal entry card and open a filterable paginated child page', async ({ app }) => {
  const { page } = app;
  await openModelUsage(page);

  const entry = page.getByRole('button', { name: /请求日志/ });
  const arrow = entry.locator('svg');
  await expect(entry).toBeVisible();
  await expect(arrow).toHaveCSS('width', '18px');
  await expect(arrow).toHaveCSS('height', '18px');
  expect((await entry.boundingBox())?.height).toBeLessThan(120);
  await expectNoHorizontalOverflow(page);

  await entry.click();
  await expect(page.getByRole('heading', { name: '请求日志' })).toBeVisible();
  await expect(page.getByRole('heading', { name: '筛选请求' })).toBeVisible();
  const requestPageHeader = page.locator('.model-usage-request-page-header');
  const requestPageBack = page.getByRole('button', { name: '返回模型用量' });
  const requestPageHeaderBox = await requestPageHeader.boundingBox();
  expect(requestPageHeaderBox?.height).toBeLessThan(180);
  if ((page.viewportSize()?.width ?? 0) <= 390) {
    expect(requestPageHeaderBox?.y).toBeGreaterThanOrEqual(12);
    await expect(page.locator('.model-usage-request-logs-page')).toHaveCSS('padding-bottom', '0px');
  }
  expect((await requestPageBack.boundingBox())?.width).toBeLessThan(80);
  await expect(page.getByRole('button', { name: /请求日期/ })).toBeVisible();
  await expect(page.getByText('模型能力', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '全部能力' })).toBeVisible();
  await expect(page.getByText('核对状态', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '全部状态' })).toBeVisible();
  await expect(page.getByLabel('Provider')).toBeVisible();
  await expect(page.getByLabel('模型', { exact: true })).toBeVisible();
  await expect(page.locator('input[type="date"], input[type="month"]')).toHaveCount(0);
  await expect(page.getByText('共 23 次请求')).toBeVisible();
  await expect(page.getByText('第 1 / 2 页')).toBeVisible();

  const filteredRequest = page.waitForRequest((request) => {
    const url = new URL(request.url());
    return url.pathname === '/api/model-usage/family/requests'
      && url.searchParams.get('provider') === 'dashscope'
      && url.searchParams.get('date_from') === '2026-08-06'
      && url.searchParams.get('date_to') === '2026-08-08'
      && !url.searchParams.has('period');
  });
  await page.getByRole('button', { name: /请求日期/ }).click();
  await saveVisualReviewScreenshot(page, `${page.viewportSize()?.width ?? 'unknown'}x${page.viewportSize()?.height ?? 'unknown'}-date-range-picker.png`);
  await page.getByRole('gridcell', { name: /2026年8月6日/ }).click();
  await page.getByRole('gridcell', { name: /2026年8月8日/ }).click();
  await page.getByRole('button', { name: '应用范围' }).click();
  await page.getByLabel('Provider').fill('dashscope');
  await page.getByRole('button', { name: '查询记录' }).click();
  await filteredRequest;
  await expect(page.getByText('qwen3-rerank').first()).toBeVisible();
  await expect(page.getByText(/model-usage-request-|provider-request-/)).toHaveCount(0);
  await expectNoHorizontalOverflow(page);
  await saveVisualReviewScreenshot(page, `${page.viewportSize()?.width ?? 'unknown'}x${page.viewportSize()?.height ?? 'unknown'}-request-logs.png`);
});

test.describe('personal empty model usage', () => {
  test.use({ modelUsageScenario: 'owner-empty-personal' });

  test('@p0 @model-usage-390x844 @model-usage-1440x900 personal partial month keeps the empty state concise', async ({ app }) => {
    const { page } = app;
    await openModelUsage(page);
    await page.getByRole('button', { name: '我的' }).click();

    await expect(page.getByRole('heading', { name: '我的模型用量' })).toBeVisible();
    await expect(page.getByText('从 2026 年 8 月 5 日开始记录')).toBeVisible();
    await expect(page.getByRole('heading', { name: '本月还没有模型调用' })).toBeVisible();
    await expect(page.getByRole('heading', { name: '需要核对的用量' })).toHaveCount(0);
    await expect(page.getByText(/避免把未知情况伪装成精确数据/)).toHaveCount(0);
    await expectNoHorizontalOverflow(page);
    await saveVisualReviewScreenshot(page, `${page.viewportSize()?.width ?? 'unknown'}-personal-empty.png`);
  });
});

test('@p0 @model-usage-1440x900 owner switches between family and personal model usage', async ({ app }) => {
  const { page, requestedApiPaths } = app;
  await openModelUsage(page);

  await page.getByRole('button', { name: '我的' }).click();

  await expect(page.getByRole('heading', { name: '我的模型用量' })).toBeVisible();
  await expect.poll(() => requestedApiPaths.some((path) => path === '/api/model-usage/me/overview')).toBe(true);
  await expect(page.getByText('家庭额度', { exact: true })).toHaveCount(0);

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
  await expect(page.getByRole('heading', { name: '家庭预算已达到 80%' })).toBeVisible();

  await page.getByRole('button', { name: /查看通知/ }).first().click();
  const dismissRequest = page.waitForRequest((request) => (
    request.method() === 'POST'
    && new URL(request.url()).pathname === '/api/model-usage/alerts/alert-model-usage-p0/dismiss'
  ));
  await page.getByRole('button', { name: '清除模型用量需要处理通知' }).click();
  await dismissRequest;
  await expect(page.getByRole('button', { name: '查看模型用量需要处理' })).toHaveCount(0);
});

test('@p0 @model-usage-375x812 @model-usage-390x844 @model-usage-430x932 @model-usage-768x1024 @model-usage-1024x768 @model-usage-1440x900 owner sees a concise budget workspace and saves a policy', async ({ app }) => {
  const { page } = app;
  await openModelUsage(page);

  await page.getByRole('button', { name: '预算设置' }).click();
  await expect(page.getByRole('heading', { name: '模型预算设置' })).toBeVisible();
  await expect(page.getByRole('region', { name: '当前预算策略' })).toBeVisible();
  await expect(page.getByLabel('家庭月预算（元）')).toHaveValue('80');
  await expect(page.getByText(/新发起的模型调用会按新额度检查/)).toBeVisible();
  await expect(page.getByText(/Decimal|持久化发送授权|放行凭证/)).toHaveCount(0);
  if ((page.viewportSize()?.width ?? 0) < 768) {
    await expect(page.locator('.model-usage-policy-mobile > .model-usage-policy-settings')).toHaveCSS('overflow-y', 'visible');
  }
  await expectNoHorizontalOverflow(page);
  await saveVisualReviewScreenshot(page, `${page.viewportSize()?.width ?? 'unknown'}x${page.viewportSize()?.height ?? 'unknown'}-budget-settings.png`);

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
    await expect(page.getByText('家庭额度', { exact: true })).toHaveCount(0);
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
  await page.getByLabel('细分方式').selectOption('provider_model');

  await expect(page.getByText('当前离线，正在显示已缓存的数据。')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText('家庭额度', { exact: true })).toBeVisible();

  await context.setOffline(false);
  await page.unroute(failingBreakdown);
  await page.getByLabel('细分方式').selectOption('capability');
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
  await expect(page.getByLabel('细分方式')).toBeVisible();
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
