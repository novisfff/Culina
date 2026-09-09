import { expect, test } from './fixtures/p0App.mjs';

async function openUsage(page, testInfo) {
  await page.clock.setFixedTime(new Date('2026-08-30T09:00:00+08:00'));
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: '家庭', exact: true }).first().click();
  await testInfo.attach('family-ai-entry-icons', { body: await page.getByRole('button', { name: /模型用量.*查看/ }).locator('..').screenshot(), contentType: 'image/png' });
  await page.getByRole('button', { name: /模型用量.*查看/ }).click();
}

async function checkpoint(page, testInfo, name) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
  await testInfo.attach(name, { body: await page.screenshot({ animations: 'disabled' }), contentType: 'image/png' });
}

test('@p0 carries usage context through records and saves an explicit budget edit', async ({ app }, testInfo) => {
  const { page } = app;
  await openUsage(page, testInfo);
  await expect(page.getByRole('heading', { name: '家庭模型用量' })).toBeVisible();
  await checkpoint(page, testInfo, 'usage-overview');
  await page.getByRole('button', { name: '我的', exact: true }).click();
  await page.getByLabel('选择统计周期').fill('2026-06');
  await page.getByRole('button', { name: '请求记录', exact: true }).click();
  await expect(page.getByRole('button', { name: '我的', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByText(/已应用：2026-06-01/)).toBeVisible();
  await page.getByRole('button', { name: '返回模型用量' }).click();
  await expect(page.getByRole('heading', { name: '我的模型用量' })).toBeVisible();
  await expect(page.getByLabel('选择统计周期')).toHaveValue('2026-06');

  await page.getByLabel('选择统计周期').fill('2026-08');
  await page.getByRole('button', { name: '家庭', exact: true }).last().click();
  await page.getByRole('button', { name: '请求记录', exact: true }).click();
  const firstRecord = page.locator('.model-usage-request-record').first();
  const recordBox = await firstRecord.boundingBox();
  expect(recordBox.height).toBeLessThanOrEqual(testInfo.project.use.viewport.width < 768 ? 140 : 80);
  await page.getByRole('heading', { name: '请求记录', exact: true }).last().scrollIntoViewIfNeeded();
  await checkpoint(page, testInfo, 'compact-request-records');
  await expect(page.locator('.model-usage-request-record details')).toHaveCount(0);
  await expect(page.locator('.model-usage-request-record-meters').first()).toBeVisible();
  await page.getByRole('heading', { name: '请求记录', exact: true }).last().scrollIntoViewIfNeeded();
  await checkpoint(page, testInfo, 'request-records');
  await page.getByRole('button', { name: '返回模型用量' }).click();

  await page.getByRole('button', { name: '预算设置', exact: true }).click();
  await page.getByLabel('家庭月预算（元）').fill('120');
  await expect(page.getByText('有未保存修改')).toBeVisible();
  await checkpoint(page, testInfo, 'budget-settings');
  await page.getByRole('checkbox', { name: '图片生成限额', exact: true }).check();
  const expand = page.getByRole('button', { name: '展开图片生成限额设置' });
  if (await expand.isVisible()) await expand.click();
  await page.getByLabel('图片生成限额上限').fill('10');
  await page.getByRole('button', { name: '保存设置', exact: true }).click();
  await expect(page.getByRole('heading', { name: '家庭模型用量' })).toBeVisible();
  await expect(page.getByLabel('家庭月预算（元）')).toHaveCount(0);
});

test.describe('personal usage', () => {
  test.use({ modelUsageScenario: 'member' });
  test('@p0 keeps personal records free of family controls and diagnostics', async ({ app }, testInfo) => {
    const { page } = app;
    await openUsage(page, testInfo);
    await expect(page.getByRole('heading', { name: '我的模型用量' })).toBeVisible();
    await expect(page.getByRole('button', { name: '预算设置', exact: true })).toHaveCount(0);
    await checkpoint(page, testInfo, 'personal-overview');
    await page.getByRole('button', { name: '请求记录', exact: true }).click();
    await expect(page.locator('.model-usage-request-record details')).toHaveCount(0);
  await expect(page.locator('.model-usage-request-record-meters').first()).toBeVisible();
    await expect(page.getByLabel('模型', { exact: true })).toHaveCount(0);
    await expect(page.getByRole('region', { name: '请求记录筛选' }).getByRole('button', { name: '家庭', exact: true })).toHaveCount(0);
    await checkpoint(page, testInfo, 'personal-records');
  });
});
