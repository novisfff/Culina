import { expect } from '@playwright/test';

export async function expectNoHorizontalOverflow(page) {
  await expect.poll(() => page.evaluate(
    () => Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - window.innerWidth,
  ), { message: '页面不应产生横向溢出' }).toBeLessThanOrEqual(1);
}

export async function attachCheckpointScreenshot(page, testInfo, name) {
  if (process.env.CULINA_P0_CHECKPOINTS !== '1') return;
  await testInfo.attach(name, {
    body: await page.screenshot({ animations: 'disabled', caret: 'hide' }),
    contentType: 'image/png',
  });
}

export async function stabilizeDarwinVisualGutter(page) {
  if (process.platform === 'darwin') {
    await page.addStyleTag({ content: 'html, .app-content { scrollbar-gutter: auto !important; }' });
  }
}

export async function openMealHistory(page, isPhone) {
  await page.getByRole('button', { name: '吃什么', exact: true }).first().click();
  const surface = page.locator(isPhone ? '.food-mobile-view' : '.food-workspace .hero-actions');
  await surface.getByRole('button', { name: '用餐记录', exact: true }).click();
  await expect(page.locator(isPhone ? '.mobile-log-page' : '.meal-log-desktop-view')).toBeVisible();
}

export async function openModelSettings(page) {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: '家庭', exact: true }).first().click();
  await page.getByRole('button', { name: /AI 服务.*管理家庭/ }).click();
  await page.getByRole('button', { name: /^功能设置/ }).click();
  await expect(page.getByRole('combobox', { name: '模型名称', exact: true })).toBeVisible();
}
