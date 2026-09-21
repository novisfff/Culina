import { expect, test } from './fixtures/p0App.mjs';

for (const [width, height] of [[375, 812], [390, 844], [430, 932], [768, 1024], [1024, 768], [1440, 900]]) {
  test(`request ledger ${width}`, async ({ app }, testInfo) => {
    const { page } = app;
    await page.setViewportSize({ width, height });
    await page.clock.setFixedTime(new Date('2026-08-30T09:00:00+08:00'));
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: '家庭', exact: true }).first().click();
    await page.getByRole('button', { name: /模型用量.*查看/ }).click();
    await page.getByRole('button', { name: '请求记录', exact: true }).click();
    await expect(page.getByRole('button', { name: '模型功能', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '核对状态', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '更多筛选' })).toHaveAttribute('aria-expanded', 'false');
    await expect(page.locator('.model-usage-request-record')).toHaveCount(20);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
    await testInfo.attach(`requests-${width}`, { body: await page.screenshot(), contentType: 'image/png' });
    await page.getByRole('button', { name: '更多筛选' }).click();
    await page.getByLabel('模型', { exact: true }).fill('nonexistent-model');
    await expect(page.locator('.model-usage-request-record')).toHaveCount(20);
    await page.getByRole('button', { name: '查看记录', exact: true }).click();
    await expect(page.getByText('没有符合当前条件的请求记录。')).toBeVisible();
    await page.getByRole('button', { name: '清除筛选' }).click();
    await expect(page.locator('.model-usage-request-record')).toHaveCount(20);
    await page.getByRole('button', { name: '下一页' }).click();
    await expect(page.locator('.model-usage-request-record')).toHaveCount(3);
    await expect(page.getByText('第 2 / 2 页')).toBeVisible();
  });
}

test('dense ledger with all five token meters', async ({ app }, testInfo) => {
  const { page } = app;
  await page.context().route('**/api/model-usage/family/requests?**', async (route) => {
    await route.fulfill({ json: {
      family_id: 'family-smoke', date_from: '2026-08-01', date_to: '2026-08-31', scope: 'family', source: 'raw', total: 5, limit: 20, offset: 0,
      items: Array.from({ length: 5 }, (_, i) => ({
        id: `dense-${i}`, occurred_at: '2026-08-20T08:09:32Z', capability: 'llm',
        provider: 'private-provider', requested_model: 'private-model', billing_model: 'private-model',
        provider_outcome: i === 0 ? 'not_billed' : 'succeeded', execution_certainty: 'confirmed',
        measurement_status: i === 0 ? 'estimated' : 'exact', pricing_status: 'priced', cost_cny: i === 0 ? '0' : '0.08',
        meters: [
          { meter: 'cached_input_tokens', quantity: '130944' }, { meter: 'input_tokens', quantity: '131336' },
          { meter: 'output_tokens', quantity: '53' }, { meter: 'total_tokens', quantity: '131389' },
          { meter: 'uncached_input_tokens', quantity: '392' },
        ],
      })),
    } });
  });
  await page.clock.setFixedTime(new Date('2026-08-30T09:00:00+08:00'));
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: '家庭', exact: true }).first().click();
  await page.getByRole('button', { name: /模型用量.*查看/ }).click();
  await page.getByRole('button', { name: '请求记录', exact: true }).click();
  for (const [width, height] of [[1440, 900], [375, 812]]) {
    await page.setViewportSize({ width, height });
    const record = page.locator('.model-usage-request-record').first();
    await expect(record.getByText('131389', { exact: true })).toBeVisible();
    expect((await record.boundingBox()).height).toBeLessThanOrEqual(width === 375 ? 180 : 100);
    const overflowing = await record.evaluate((row) => Array.from(row.querySelectorAll('dl > div')).some((cell) => cell.getBoundingClientRect().right > row.getBoundingClientRect().right));
    expect(overflowing).toBe(false);
    await record.scrollIntoViewIfNeeded();
    await testInfo.attach(`dense-requests-${width}`, { body: await page.screenshot(), contentType: 'image/png' });
  }
});
