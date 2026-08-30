import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from './fixtures/p0App.mjs';

const VIEWPORTS = [
  [375, 812], [390, 844], [430, 932], [768, 1024], [1024, 768], [1440, 900],
];

function outputPath() {
  return path.resolve(process.env.RELEASE_EVIDENCE_OUTPUT ?? '.artifacts/release-request-report.json');
}

test('@release-evidence captures six viewport request and performance evidence', async ({ app, page }) => {
  const viewports = {};
  for (const [width, height] of VIEWPORTS) {
    const key = `${width}x${height}`;
    await page.setViewportSize({ width, height });
    await page.goto('/', { waitUntil: 'networkidle' });
    await expect(page.getByRole('heading', { name: '今天吃什么' })).toBeVisible();
    const nav = (name) => page.locator('.mobile-bottom-nav:visible, .sidebar-nav:visible, .tabbar:visible').getByRole('button', { name, exact: true }).first();
    await nav('食材').click();
    await expect(page.getByRole('heading', { name: '食材' })).toBeVisible();
    await nav('吃什么').click();
    await expect(page.getByRole('heading', { name: '吃什么' })).toBeVisible();
    await nav('AI').click();
    await expect(page.locator('.ai-mobile-page:visible, .ai-desktop-view:visible').getByText('AI 厨房助手', { exact: true })).toBeVisible();
    await page.goto('/', { waitUntil: 'networkidle' });
    await expect(page.getByRole('heading', { name: '今天吃什么' })).toBeVisible();
    await nav('家庭').click();
    await expect(page.locator('.family-desktop-view:visible, .mobile-family-page:visible').getByRole('heading').first()).toBeVisible();
    const metrics = await page.evaluate(() => {
      const longTasks = performance.getEntriesByType('longtask');
      return { longTaskMs: longTasks.reduce((max, entry) => Math.max(max, entry.duration), 0) };
    });
    viewports[key] = { status: 'passed', longTaskMs: metrics.longTaskMs };
  }

  const requestCount = app.requestedApiPaths.length;
  const uniqueRequestCount = new Set(app.requestedApiPaths).size;
  const report = {
    version: 1,
    browserRun: true,
    requestCount,
    uniqueRequestCount,
    cacheReuse: uniqueRequestCount < requestCount,
    longTaskMs: Math.max(...Object.values(viewports).map((item) => item.longTaskMs ?? 0)),
    viewports,
  };
  const target = outputPath();
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  expect(requestCount).toBeGreaterThan(0);
});
