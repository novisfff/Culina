import { expect, test } from './fixtures/p0App.mjs';
import { attachCheckpointScreenshot, expectNoHorizontalOverflow, openModelSettings } from './fixtures/browserHelpers.mjs';

test.use({ familyModelScenario: 'qwen-tts' });

test('model output and Qwen audio controls remain reachable', async ({ app }, testInfo) => {
  const { page } = app;
  await openModelSettings(page);
  const tokens = page.getByLabel('最大回复长度（Token）', { exact: true });
  await tokens.scrollIntoViewIfNeeded();
  await expect(tokens).toBeInViewport();
  const advanced = page.locator('.family-model-settings-binding-advanced');
  if (!(await advanced.evaluate((element) => element.open))) await advanced.locator('summary').click();
  const cache = page.getByRole('checkbox', { name: '提示词缓存', exact: true });
  await expect(cache).toBeChecked();
  await cache.locator('..').scrollIntoViewIfNeeded();
  await expect(cache.locator('..').locator('.family-model-settings-switch-track')).toBeInViewport();
  await expectNoHorizontalOverflow(page);
  await attachCheckpointScreenshot(page, testInfo, 'model-output-controls');

  await page.getByRole('button', { name: '对话与图片理解 · 主用', exact: true }).click();
  await page.getByRole('button', { name: '语音播报 · 默认', exact: true }).click();
  const format = page.getByRole('button', { name: '音频格式', exact: true });
  await format.scrollIntoViewIfNeeded();
  await expect(format).toBeInViewport();
  await expect(format).toBeDisabled();
  await expect(format).toHaveText('WAV');
  await expect(page.getByLabel('音色', { exact: true })).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await attachCheckpointScreenshot(page, testInfo, 'qwen-audio-controls');
});
