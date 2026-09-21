import { expect, test } from './fixtures/p0App.mjs';

// Run this focused matrix on a single Playwright project; each case owns its viewport.
for (const viewport of [
  { width: 375, height: 812 },
  { width: 390, height: 844 },
  { width: 430, height: 932 },
  { width: 768, height: 1024 },
  { width: 1024, height: 768 },
  { width: 1440, height: 900 },
]) {
  test(`@p0 usage ledger fits ${viewport.width}x${viewport.height} and exposes details`, async ({ app }, testInfo) => {
    const { page } = app;
    await page.setViewportSize(viewport);
    await page.clock.setFixedTime(new Date('2026-08-30T09:00:00+08:00'));
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: '家庭', exact: true }).first().click();
    await page.getByRole('button', { name: /模型用量.*查看/ }).click();
    await expect(page.getByRole('heading', { name: '家庭模型用量' })).toBeVisible();
    await page.getByLabel('选择统计周期').fill('2026-07');
    await expect(page.getByText(/最高单日费用出现在/, { exact: false }).last()).toBeVisible();

    const ledger = page.locator('.model-usage-ledger');
    await expect(ledger.getByText('已预留费用')).not.toBeVisible();
    await ledger.getByText('额度计算说明', { exact: true }).click();
    await expect(ledger.getByText('已预留费用')).toBeVisible();
    await ledger.getByText('额度计算说明', { exact: true }).click();
    // The fixture has a measurement gap: critical details must start expanded.
    await expect(page.locator('.model-usage-health-list')).toBeVisible();
    await page.getByText('需要核对的用量', { exact: true }).click();
    await expect(page.locator('.model-usage-health-list')).not.toBeVisible();
    await page.getByText('需要核对的用量', { exact: true }).click();
    await expect(page.locator('.model-usage-health-list')).toBeVisible();
    await page.getByText('需要核对的用量', { exact: true }).click();
    await page.getByText('查看每日费用', { exact: true }).click();
    await expect(page.getByRole('table', { name: '每日费用明细' })).toBeVisible();
    await expect(page.getByRole('table', { name: '每日费用明细' }).locator('tbody tr')).toHaveCount(30);
    await page.getByText('查看每日费用', { exact: true }).click();

    const overflow = await ledger.evaluate((root) => [...root.querySelectorAll('*')]
      .filter((element) => element.getClientRects().length && element.scrollWidth > element.clientWidth + 2 && getComputedStyle(element).overflowX === 'visible')
      .map((element) => ({ tag: element.tagName, className: element.getAttribute('class'), width: element.clientWidth, scroll: element.scrollWidth })));
    expect(overflow).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
    const chart = page.locator('.model-usage-trend-chart-wrapper');
    expect(await chart.evaluate((node) => node.scrollWidth - node.clientWidth)).toBeLessThanOrEqual(1);
    if (viewport.width < 1024) {
      for (const name of ['请求记录', '预算设置']) {
        const box = await ledger.getByRole('button', { name, exact: true }).boundingBox();
        expect(box.height).toBeGreaterThanOrEqual(44);
      }
    }
    await page.getByRole('heading', { name: '家庭模型用量' }).scrollIntoViewIfNeeded();
    await testInfo.attach(`ledger-${viewport.width}`, { body: await page.screenshot({ fullPage: true }), contentType: 'image/png' });
    await page.getByRole('heading', { name: '用量明细', exact: true }).scrollIntoViewIfNeeded();
    await testInfo.attach(`ledger-detail-${viewport.width}`, { body: await page.screenshot(), contentType: 'image/png' });
  });
}

for (const viewport of [{ width: 375, height: 812 }, { width: 1440, height: 900 }]) {
  test(`@p0 zero-cost usage stays informative at ${viewport.width}px`, async ({ app }, testInfo) => {
    const { page } = app;
    await page.setViewportSize(viewport);
    await page.clock.setFixedTime(new Date('2026-09-20T09:00:00+08:00'));
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: '家庭', exact: true }).first().click();
    const overviewResponse = page.waitForResponse((response) => response.url().includes('/model-usage/family/overview'));
    await page.getByRole('button', { name: /模型用量.*查看/ }).click();
    const overview = await (await overviewResponse).json();
    const health = {
      exact_event_count: 153, estimated_event_count: 62, unpriced_event_count: 0,
      uncertain_attempt_count: 0, pending_attempt_count: 0,
      unresolved_unknown_execution_attempt_count: 53, conservative_estimated_cost_cny: '0',
      known_unmeasured_attempt_count: 0, measurement_gap: false, measurement_gap_scope: [], gap_intervals: [],
    };
    await page.context().route('**/api/model-usage/family/overview?*', async (route) => {
      const period = new URL(route.request().url()).searchParams.get('period');
      await route.fulfill({ json: {
        ...overview, period, is_partial_period: false, known_priced_cost_cny: '0',
        monthly_budget_cny: '100', effective_spend_cny: '0', reserved_cost_cny: '0',
        pricing_complete: true, unpriced_event_count: 0, hard_limit_enabled: false,
        measurement_health: health,
        meter_totals: [
          { meter: 'cached_input_tokens', quantity: '727424' },
          { meter: 'input_tokens', quantity: '1431600' },
          { meter: 'output_tokens', quantity: '553188' },
          { meter: 'total_tokens', quantity: '1984788' },
          { meter: 'uncached_input_tokens', quantity: '704176' },
          { meter: 'embedding_tokens', quantity: '49330' },
          { meter: 'generated_images', quantity: '3' },
          { meter: 'request_units', quantity: '215' },
        ],
      } });
    });
    await page.context().route('**/api/model-usage/family/breakdown?*', async (route) => {
      const url = new URL(route.request().url());
      const period = url.searchParams.get('period');
      const groupBy = url.searchParams.get('group_by');
      await route.fulfill({ json: {
        scope: 'family', family_id: overview.family_id, period, group_by: groupBy,
        items: ['llm', 'image_generation', 'embedding'].map((capability) => ({
          label: capability, capability, provider: null, billing_model: null,
          meter: null, meter_total: null, local_day: groupBy === 'daily_capability_cost' ? `${period}-18` : null,
          known_priced_cost_cny: '0', total_cost_cny: '0', pricing_complete: true, unpriced_event_count: 0,
          measurement_health: health,
        })),
      } });
    });
    // Change period to exercise fresh query data rather than the cached initial fixture.
    await page.getByLabel('选择统计周期').fill('2026-08');
    await expect(page.getByText('这 30 天已计入费用为 ¥0.00')).toBeVisible();
    await expect(page.getByText('暂无可分配的费用')).toBeVisible();
    await expect(page.getByText('1,984,788', { exact: true })).toBeVisible();
    await expect(page.getByText('含估算用量 · 62')).toBeVisible();
    await expect(page.getByText('请求状态待确认 · 53')).toBeVisible();
    await expect(page.locator('.model-usage-health-list')).not.toBeVisible();
    expect(await page.locator('.model-usage-ledger').evaluate((root) => [...root.querySelectorAll('*')]
      .filter((node) => node.getClientRects().length && node.scrollWidth > node.clientWidth + 2 && getComputedStyle(node).overflowX === 'visible')
      .map((node) => node.className))).toEqual([]);
    await page.getByRole('heading', { name: '家庭模型用量' }).scrollIntoViewIfNeeded();
    await testInfo.attach(`zero-cost-${viewport.width}`, { body: await page.screenshot({ fullPage: true }), contentType: 'image/png' });
    await page.getByRole('heading', { name: '用量明细', exact: true }).scrollIntoViewIfNeeded();
    await testInfo.attach(`zero-cost-details-${viewport.width}`, { body: await page.screenshot(), contentType: 'image/png' });
  });
}
