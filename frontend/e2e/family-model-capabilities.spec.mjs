import { expect, test } from './fixtures/p0App.mjs';

test('@p0 configures image generation from the capability overview', async ({ app }, testInfo) => {
  const { page, familyModelRequests } = app;
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: '家庭', exact: true }).first().click();
  await page.getByRole('button', { name: /AI 服务.*管理家庭/ }).click();
  await page.getByRole('button', { name: /功能设置/ }).first().click();

  const chat = page.getByRole('button', { name: /对话与图片理解 · 主用/ });
  await expect(chat).toContainText('culina-chat-v1');
  await chat.click();
  await expect(chat).toHaveAttribute('aria-expanded', 'false');
  await expect(chat).toContainText('家庭主服务');

  await testInfo.attach('capability-overview', {
    body: await page.screenshot({ animations: 'disabled' }),
    contentType: 'image/png',
  });
  await page.getByRole('button', { name: /图片生成 · 文字生成/ }).click();
  const portrait = page.getByRole('radio', { name: /竖版/ });
  await portrait.click();
  await expect(portrait).toHaveAttribute('aria-checked', 'true');
  await expect.poll(() => familyModelRequests.some((request) =>
    request.method === 'PUT' && request.body?.bindings?.some((binding) =>
      binding.capability === 'image_generation' && binding.image_size === '1024x1536'),
    ),
  ).toBe(true);
  await expect(page.getByText('测试会发送真实请求，可能产生模型费用。')).toBeVisible();
  await page.getByText('高级设置', { exact: true }).click();
  await expect(page.getByRole('button', { name: '返回格式', exact: true })).toBeVisible();
  await page.getByText('高级设置', { exact: true }).click();
  await page.getByRole('button', { name: '模型服务', exact: true }).scrollIntoViewIfNeeded();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(1);
  await testInfo.attach('image-generation-settings', {
    body: await page.screenshot({ fullPage: true, animations: 'disabled' }),
    contentType: 'image/png',
  });
  await page.getByRole('button', { name: '测试功能', exact: true }).scrollIntoViewIfNeeded();
  await testInfo.attach('capability-test-action', {
    body: await page.screenshot({ animations: 'disabled' }),
    contentType: 'image/png',
  });
});
