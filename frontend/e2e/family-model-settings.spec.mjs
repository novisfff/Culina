import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { expect, test } from './fixtures/p0App.mjs';

const VIEWPORTS = [
  { width: 375, height: 812 },
  { width: 390, height: 844 },
  { width: 430, height: 932 },
  { width: 768, height: 1024 },
  { width: 1024, height: 768 },
  { width: 1440, height: 900 },
];

async function openFamilyModelSettings(page) {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  const mobileFamilyNavigation = page.locator('.mobile-bottom-nav:visible').getByRole('button', { name: '家庭' });
  const desktopFamilyNavigation = page.locator('.sidebar-nav:visible').getByRole('button', { name: '家庭' });
  await mobileFamilyNavigation.or(desktopFamilyNavigation).click();
  await page.locator('.family-ai-services-entry:visible, .mobile-family-ai-services-entry:visible').first().click();
}

async function openModelUsage(page) {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  const mobileFamilyNavigation = page.locator('.mobile-bottom-nav:visible').getByRole('button', { name: '家庭' });
  const desktopFamilyNavigation = page.locator('.sidebar-nav:visible').getByRole('button', { name: '家庭' });
  await mobileFamilyNavigation.or(desktopFamilyNavigation).click();
  await page.locator('.family-model-usage-entry:visible, .mobile-family-model-usage-entry:visible').first().click();
}

async function expectNoHorizontalOverflow(page) {
  const overflow = await page.evaluate(
    () => Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - window.innerWidth,
  );
  expect(overflow, '家庭 AI 服务页面不应产生横向溢出').toBeLessThanOrEqual(1);
}

async function saveVisualReviewScreenshot(page, filename) {
  const outputDirectory = process.env.FAMILY_MODEL_SETTINGS_VISUAL_REVIEW_DIR;
  if (!outputDirectory) return;

  const absoluteDirectory = path.resolve(outputDirectory);
  await mkdir(absoluteDirectory, { recursive: true });
  await page.screenshot({
    path: path.join(absoluteDirectory, filename),
    fullPage: true,
    animations: 'disabled',
  });
}

function hasSecretMarker(value, marker) {
  return JSON.stringify(value).includes(marker);
}

for (const viewport of VIEWPORTS) {
  test(`@p0 @family-model-settings-${viewport.width}x${viewport.height} Owner can reach the AI services workspace at ${viewport.width}×${viewport.height}`, async ({ app }) => {
    const { page } = app;
    expect(page.viewportSize()).toEqual(viewport);

    await openFamilyModelSettings(page);

    await expect(page.getByRole('heading', { name: '家庭 AI 服务', exact: true })).toBeVisible();
    if (viewport.width < 768) {
      await expect(page.locator('.family-model-settings-mobile-page')).toBeVisible();
      await expect(page.locator('.family-model-settings-mobile-scroll')).toBeVisible();
      await expect(page.locator('.family-model-settings-mobile-footer')).toBeVisible();
    } else {
      await expect(page.locator('.family-model-settings-desktop')).toBeVisible();
      await expect(page.getByRole('navigation', { name: '家庭 AI 服务设置分区' })).toBeVisible();
      if (viewport.width >= 768 && viewport.width < 1024) {
        const mainPanelBox = await page.locator('.family-model-settings-main-panel').boundingBox();
        expect(mainPanelBox, '平板端主内容面板应完成布局').not.toBeNull();
        expect(mainPanelBox?.width ?? 0, '平板端主内容不应被双侧栏压缩到不可读宽度').toBeGreaterThanOrEqual(400);
      }
    }
    await expectNoHorizontalOverflow(page);
    await saveVisualReviewScreenshot(page, `${viewport.width}x${viewport.height}-entry.png`);
  });
}

test.describe('@p0 @family-model-settings-1440x900 workspace navigation contract', () => {
  test.use({ familyModelScenario: 'configured' });

  test('browser back returns a clean workspace to the family profile', async ({ app }) => {
    const { page } = app;
    await openFamilyModelSettings(page);
    await expect.poll(() => page.evaluate(() => window.history.state?.culinaWorkspaceGuard ?? null))
      .toBe('family-model-settings:family-smoke');

    await page.goBack();

    await expect(page.getByRole('heading', { name: '家庭 AI 服务', exact: true })).toHaveCount(0);
    await expect(page.getByRole('heading', { name: '我的家庭', exact: true })).toBeVisible();
  });

  test('browser back asks before discarding an unsaved draft', async ({ app }) => {
    const { page } = app;
    await openFamilyModelSettings(page);
    await page.locator('.family-model-settings-section-rail')
      .getByRole('button', { name: /^能力配置/ }).click();
    const llmCard = page.locator('.family-model-settings-binding-card')
      .filter({ hasText: '对话与视觉理解 · 主用' });
    await llmCard.getByLabel('模型名称').fill('unsaved-browser-back-model');

    await page.goBack();

    await expect(page.getByRole('heading', { name: '放弃未保存的配置修改？' })).toBeVisible();
    await page.locator('.ui-form-actions-secondary').click();
    await expect(page.getByRole('heading', { name: '家庭 AI 服务', exact: true })).toBeVisible();
    await expect(llmCard.getByLabel('模型名称')).toHaveValue('unsaved-browser-back-model');
  });

  test('Escape and backdrop stay inert while a draft mutation is pending', async ({ app }) => {
    const { page } = app;
    let releaseDraftRequest;
    const draftRequestGate = new Promise((resolve) => {
      releaseDraftRequest = resolve;
    });
    await page.route('**/api/family/model-settings/draft', async (route) => {
      if (route.request().method() === 'PUT') await draftRequestGate;
      await route.fallback();
    });

    await openFamilyModelSettings(page);
    await page.locator('.family-model-settings-section-rail')
      .getByRole('button', { name: /^能力配置/ }).click();
    await page.locator('.family-model-settings-binding-card')
      .filter({ hasText: '对话与视觉理解 · 主用' })
      .getByLabel('模型名称')
      .fill('busy-overlay-model');
    await page.goBack();
    const discardDialog = page.getByRole('heading', { name: '放弃未保存的配置修改？' });
    await expect(discardDialog).toBeVisible();

    const draftRequest = page.waitForRequest((request) => (
      request.method() === 'PUT'
      && new URL(request.url()).pathname === '/api/family/model-settings/draft'
    ));
    await page.getByRole('button', { name: '保存草稿' }).evaluate((button) => button.click());
    await draftRequest;
    await expect(page.locator('.family-model-settings-workspace')).toHaveAttribute('aria-busy', 'true');

    await page.keyboard.press('Escape');
    await page.locator('.workspace-overlay-backdrop').click({ position: { x: 8, y: 8 } });
    await expect(discardDialog).toBeVisible();

    releaseDraftRequest();
    await expect(page.locator('.family-model-settings-workspace')).not.toHaveAttribute('aria-busy', 'true');
  });
});

test.describe('@p0 @family-model-settings-1440x900 Owner provider credential boundaries', () => {
  test.use({ familyModelScenario: 'configured' });

  test('uses write-only keys only for create and rotation, while endpoint changes create a new profile', async ({ app }) => {
    const { familyModelRequests, page } = app;
    const createMarker = 'create-key-marker-only-for-request';
    const rotateMarker = 'rotate-key-marker-only-for-request';

    await openFamilyModelSettings(page);
    await page.locator('.family-model-settings-section-rail')
      .getByRole('button', { name: /^Provider 档案/ }).click();
    await page.getByLabel('当前档案').selectOption('family-model-profile-http');

    await expect(page.getByText('更换服务地址或账号需要创建新档案，再重新绑定能力。')).toBeVisible();
    await expect(page.getByLabel('API 服务地址')).toHaveCount(0);

    const connectionRequest = page.waitForRequest((request) => (
      request.method() === 'POST'
      && new URL(request.url()).pathname === '/api/family/model-settings/provider-profiles/family-model-profile-http/connection-check'
    ));
    await page.getByRole('button', { name: '检查连接' }).click();
    await connectionRequest;
    await expect(page.getByText('安全检查已通过，尚未执行真实调用。')).toBeVisible();

    await page.getByRole('button', { name: '轮换 Key' }).click();
    await page.getByLabel('当前密码').fill('owner-password');
    await page.getByLabel('新的 API Key').fill(rotateMarker);
    const rotateRequestPromise = page.waitForRequest((request) => (
      request.method() === 'POST'
      && new URL(request.url()).pathname === '/api/family/model-settings/provider-profiles/family-model-profile-http/rotate-key'
    ));
    await page.getByRole('button', { name: '确认轮换' }).click();
    const rotateRequest = await rotateRequestPromise;
    expect(rotateRequest.postDataJSON()).toMatchObject({ new_api_key: rotateMarker, current_password: 'owner-password' });
    await expect(page.getByLabel('新的 API Key')).toHaveCount(0);

    await page.getByLabel('显示名称').fill('家庭主服务（已校验）');
    const patchRequestPromise = page.waitForRequest((request) => (
      request.method() === 'PATCH'
      && new URL(request.url()).pathname === '/api/family/model-settings/provider-profiles/family-model-profile-http'
    ));
    await page.getByRole('button', { name: '保存档案' }).click();
    const patchRequest = await patchRequestPromise;
    expect(patchRequest.postDataJSON()).not.toHaveProperty('api_base_url');
    expect(patchRequest.postDataJSON()).not.toHaveProperty('auth_mode');

    await page.getByRole('button', { name: '新建档案' }).click();
    await page.getByLabel('档案名称').fill('替换服务');
    await page.getByLabel('API 服务地址').fill('https://replacement.example/v1');
    const createApiKeyInput = page.locator('input[type="password"][autocomplete="new-password"]');
    await createApiKeyInput.fill(createMarker);
    const createRequestPromise = page.waitForRequest((request) => (
      request.method() === 'POST'
      && new URL(request.url()).pathname === '/api/family/model-settings/provider-profiles'
    ));
    const rebindDraftRequestPromise = page.waitForRequest((request) => (
      request.method() === 'PUT'
      && new URL(request.url()).pathname === '/api/family/model-settings/draft'
    ));
    await page.getByRole('button', { name: '创建档案' }).click();
    const createRequest = await createRequestPromise;
    const rebindDraftRequest = await rebindDraftRequestPromise;
    expect(createRequest.postDataJSON()).toMatchObject({
      api_base_url: 'https://replacement.example/v1',
      api_key: createMarker,
    });
    expect(rebindDraftRequest.postDataJSON().bindings
      .filter((binding) => binding.enabled && binding.capability !== 'embedding')
      .every((binding) => binding.provider_profile_id !== 'family-model-profile-http')).toBe(true);
    expect(rebindDraftRequest.postDataJSON().bindings
      .find((binding) => binding.capability === 'embedding')?.provider_profile_id).toBe('family-model-profile-http');

    await expect(createApiKeyInput).toHaveCount(0);
    expect(hasSecretMarker(familyModelRequests, createMarker)).toBe(false);
    expect(hasSecretMarker(familyModelRequests, rotateMarker)).toBe(false);
    expect(await page.content()).not.toContain(createMarker);
    expect(await page.content()).not.toContain(rotateMarker);
    expect(await page.evaluate(() => ({ local: { ...localStorage }, session: { ...sessionStorage } }))).not.toEqual(
      expect.objectContaining({ createMarker }),
    );
    expect(await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }))).not.toContain(createMarker);
    expect(await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }))).not.toContain(rotateMarker);
  });
});

test.describe('@p0 @family-model-settings-1440x900 Owner configuration and privacy journey', () => {
  test.use({ familyModelScenario: 'configured' });

  test('binds all seven capabilities, changes a price, validates and publishes', async ({ app }) => {
    const { page } = app;
    await openFamilyModelSettings(page);
    await page.locator('.family-model-settings-section-rail')
      .getByRole('button', { name: /^能力配置/ }).click();

    const bindingCards = page.locator('.family-model-settings-binding-card');
    await expect(bindingCards).toHaveCount(7);
    for (const label of ['对话与视觉理解', '图片生成', '语音识别', '语音播报', '实时语音', '搜索向量', '搜索重排']) {
      await expect(bindingCards.filter({ hasText: label }).getByText('已启用')).toBeVisible();
    }

    const llmCard = bindingCards.filter({ hasText: '对话与视觉理解 · 主用' });
    await llmCard.getByLabel('我确认本次测试可能产生费用').check();
    const testCapabilityRequest = page.waitForRequest((request) => (
      request.method() === 'POST'
      && new URL(request.url()).pathname === '/api/family/model-settings/capabilities/llm/test'
    ));
    await llmCard.getByRole('button', { name: '测试能力' }).click();
    await testCapabilityRequest;
    await expect(llmCard.getByText('真实能力测试已完成。')).toBeVisible();

    await llmCard.getByLabel('模型名称').fill('culina-chat-v2');
    await page.locator('.family-model-settings-section-rail')
      .getByRole('button', { name: /^模型价格/ }).click();
    const firstPriceCard = page.locator('.family-model-settings-price-card').first();
    await firstPriceCard.getByLabel('单价').fill('0.120000');
    const saveDraftRequest = page.waitForRequest((request) => (
      request.method() === 'PUT' && new URL(request.url()).pathname === '/api/family/model-settings/draft'
    ));
    await page.getByRole('button', { name: '保存草稿' }).click();
    await saveDraftRequest;
    await expect(page.getByText('草稿已同步')).toBeVisible();

    await page.getByRole('button', { name: '前往发布复核' }).click();
    const validateRequest = page.waitForRequest((request) => (
      request.method() === 'POST' && new URL(request.url()).pathname === '/api/family/model-settings/draft/validate'
    ));
    await page.getByRole('button', { name: '检查配置' }).click();
    await validateRequest;
    await expect(page.getByText('配置检查已通过')).toBeVisible();

    await page.getByLabel('当前密码').fill('owner-password');
    await page.getByLabel('我已核对能力、价格和搜索影响').check();
    const publishRequestPromise = page.waitForRequest((request) => (
      request.method() === 'POST' && new URL(request.url()).pathname === '/api/family/model-settings/publish'
    ));
    await page.getByRole('button', { name: '发布配置', exact: true }).click();
    const publishRequest = await publishRequestPromise;
    expect(publishRequest.postDataJSON()).toMatchObject({ current_password: 'owner-password' });
    await expect(page.getByLabel('当前密码')).toHaveCount(0);
    expect(await page.content()).not.toContain('owner-password');
  });

  test('clears family provider/model diagnostics before switching to personal model usage', async ({ app }) => {
    const { page } = app;
    await openModelUsage(page);
    await page.getByLabel('细分方式').selectOption('provider_model');
    await expect(page.getByLabel('细分方式')).toHaveValue('provider_model');

    const usageScope = page.getByLabel('用量范围');
    await usageScope.getByRole('button', { name: '我的', exact: true }).click();
    await expect(page.getByLabel('细分方式')).toHaveValue('capability');
    await expect(page.getByText('gpt-5.6-terra')).toHaveCount(0);

    await usageScope.getByRole('button', { name: '家庭', exact: true }).click();
    await page.getByRole('button', { name: /请求日志/ }).click();
    await page.getByLabel('Provider').fill('openai-compatible');
    await page.getByLabel('模型', { exact: true }).fill('gpt-5.6-terra');
    const familyRequest = page.waitForRequest((request) => {
      const url = new URL(request.url());
      return url.pathname === '/api/model-usage/family/requests'
        && url.searchParams.get('provider') === 'openai-compatible'
        && url.searchParams.get('model') === 'gpt-5.6-terra';
    });
    await page.getByRole('button', { name: '查询记录' }).click();
    await familyRequest;

    const personalRequestPromise = page.waitForRequest((request) => (
      new URL(request.url()).pathname === '/api/model-usage/me/requests'
    ));
    await page.getByLabel('日志范围').getByRole('button', { name: '我的', exact: true }).click();
    const personalRequest = await personalRequestPromise;
    await expect(page.getByLabel('Provider')).toHaveCount(0);
    await expect(page.getByLabel('模型', { exact: true })).toHaveCount(0);
    const personalUrl = new URL(personalRequest.url());
    expect(personalUrl.searchParams.has('provider')).toBe(false);
    expect(personalUrl.searchParams.has('model')).toBe(false);
    await expect(page.getByText(/openai-compatible|provider-request-/)).toHaveCount(0);
  });
});

test.describe('@family-model-settings-1440x900 recovery states', () => {
  test.describe('draft conflicts', () => {
    test.use({ familyModelScenario: 'conflict' });

    test('retains an unsaved edit when the server reports a stale draft conflict', async ({ app }) => {
      const { page } = app;
      await openFamilyModelSettings(page);
      await page.locator('.family-model-settings-section-rail')
        .getByRole('button', { name: /^能力配置/ }).click();
      const llmCard = page.locator('.family-model-settings-binding-card').filter({ hasText: '对话与视觉理解 · 主用' });
      const enabledSwitch = llmCard.getByRole('checkbox').first();
      await enabledSwitch.uncheck();
      await page.getByRole('button', { name: '保存草稿' }).click();

      await expect(page.getByRole('alert')).toContainText('设置已更新，请刷新后重新应用草稿。');
      await expect(enabledSwitch).not.toBeChecked();
    });
  });

  test.describe('background refresh failures', () => {
    test.use({ familyModelScenario: 'settings-refresh-failure' });

    test('keeps successful non-secret data visible while a background settings refresh fails', async ({ app }) => {
      const { page } = app;
      await openFamilyModelSettings(page);
      await expect(page.getByRole('heading', { name: '家庭 AI 服务', exact: true })).toBeVisible();

      await page.locator('.family-model-settings-section-rail')
        .getByRole('button', { name: /^能力配置/ }).click();
      const llmCard = page.locator('.family-model-settings-binding-card').filter({ hasText: '对话与视觉理解 · 主用' });
      await llmCard.getByLabel('我确认本次测试可能产生费用').check();
      const failedRefresh = page.waitForResponse((response) => (
        new URL(response.url()).pathname === '/api/family/model-settings'
        && response.status() === 503
      ));
      await llmCard.getByRole('button', { name: '测试能力' }).click();
      await failedRefresh;
      await expect(page.getByText('刷新失败，正在显示上次成功的非敏感数据。')).toBeVisible({ timeout: 15_000 });
      await expect(page.getByRole('heading', { name: '家庭 AI 服务', exact: true })).toBeVisible();
    });
  });
});

test.describe('@family-model-settings-1440x900 capability hard limit and search recovery', () => {
  test.use({ familyModelScenario: 'hard-limit' });

  test('shows a safe failed state when a billable capability test is blocked by the hard limit', async ({ app }) => {
    const { page } = app;
    await openFamilyModelSettings(page);
    await page.locator('.family-model-settings-section-rail')
      .getByRole('button', { name: /^能力配置/ }).click();
    const llmCard = page.locator('.family-model-settings-binding-card').filter({ hasText: '对话与视觉理解 · 主用' });
    await llmCard.getByLabel('我确认本次测试可能产生费用').check();
    await llmCard.getByRole('button', { name: '测试能力' }).click();
    await expect(llmCard.getByText('测试没有完成，请检查配置。')).toBeVisible();
  });
});

test.describe('@family-model-settings-1440x900 search replacement recovery', () => {
  test.use({ familyModelScenario: 'search-failed' });

  test('shows failed replacement, retries it, and reflects activation', async ({ app }) => {
    const { page } = app;
    await openFamilyModelSettings(page);
    await page.locator('.family-model-settings-section-rail')
      .getByRole('button', { name: /^搜索索引/ }).click();
    await page.getByLabel('新的 Provider 档案').selectOption('family-model-profile-http');
    await page.getByLabel('新的向量模型').fill('culina-embedding-v2');
    await page.getByLabel('向量维度').fill('2048');
    await page.getByRole('button', { name: '评估完整重建' }).click();
    await expect(page.getByText(/预计处理 42 份家庭文档/)).toBeVisible();
    await page.getByLabel('当前密码').fill('owner-password');
    await page.getByLabel('我确认开始完整重建，并理解原索引会继续提供搜索。').check();
    await page.getByRole('button', { name: '开始完整重建' }).click();
    await expect(page.getByText('重建失败，原搜索索引没有被替换。')).toBeVisible();

    await page.getByRole('button', { name: '重试重建' }).click();
    await expect(page.getByText('当前状态：active')).toBeVisible();
  });
});

test.describe('@family-model-settings-390x844 search cancellation and Member privacy', () => {
  test.use({ familyModelScenario: 'search-cancelled' });

  test('allows a provisioning replacement to be cancelled without replacing the active index', async ({ app }) => {
    const { page } = app;
    await openFamilyModelSettings(page);
    await page.locator('.family-model-settings-mobile-task-list')
      .getByRole('button', { name: '搜索索引', exact: true }).click();
    await page.getByLabel('新的 Provider 档案').selectOption('family-model-profile-http');
    await page.getByLabel('新的向量模型').fill('culina-embedding-v2');
    await page.getByLabel('向量维度').fill('2048');
    await page.getByRole('button', { name: '评估完整重建' }).click();
    await page.getByLabel('当前密码').fill('owner-password');
    await page.getByLabel('我确认开始完整重建，并理解原索引会继续提供搜索。').check();
    await page.getByRole('button', { name: '开始完整重建' }).click();
    await expect(page.getByText('正在完整重建，当前搜索索引仍可继续使用。')).toBeVisible();
    await page.getByRole('button', { name: '取消重建' }).click();
    await expect(page.getByText('当前状态：cancelled')).toBeVisible();
  });
});

test.describe('@p0 @family-model-settings-390x844 Member privacy', () => {
  test.use({ familyModelScenario: 'member' });

  test('does not expose the Owner AI services entry or request Owner settings data', async ({ app }) => {
    const { page, requestedApiPaths } = app;
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await page.locator('.mobile-bottom-nav:visible').getByRole('button', { name: '家庭' }).click();

    await expect(page.getByRole('button', { name: /AI 服务/ })).toHaveCount(0);
    expect(requestedApiPaths.some((pathname) => pathname.startsWith('/api/family/model-settings'))).toBe(false);
    expect(await page.content()).not.toMatch(/provider|api[_ -]?key|模型服务地址/i);
  });
});
