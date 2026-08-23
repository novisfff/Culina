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

async function expandBinding(card) {
  const trigger = card.locator('.family-model-settings-binding-head > button');
  await trigger.click();
  await expect(trigger).toHaveAttribute('aria-expanded', 'true');
}

async function expandPrice(card) {
  const trigger = card.locator('.family-model-settings-price-head > button');
  await trigger.click();
  await expect(trigger).toHaveAttribute('aria-expanded', 'true');
}

for (const viewport of VIEWPORTS) {
  test(`@p0 @family-model-settings-${viewport.width}x${viewport.height} Owner can reach the AI services workspace at ${viewport.width}×${viewport.height}`, async ({ app }) => {
    const { page } = app;
    expect(page.viewportSize()).toEqual(viewport);

    await openFamilyModelSettings(page);

    if (viewport.width < 768) {
      await expect(page.locator('.family-model-settings-mobile-header > strong')).toHaveText('家庭 AI 服务');
      await expect(page.locator('.family-model-settings-mobile-page')).toBeVisible();
      await expect(page.locator('.family-model-settings-mobile-scroll')).toBeVisible();
      await expect(page.locator('.family-model-settings-mobile-footer')).toBeVisible();
      await expect(page.locator('.family-model-settings-mobile-footer .solid-button')).toBeVisible();
    } else {
      await expect(page.getByRole('heading', { name: '家庭 AI 服务', exact: true })).toBeVisible();
      await expect(page.locator('.family-model-settings-desktop')).toBeVisible();
      await expect(page.getByRole('navigation', { name: '家庭 AI 服务设置分区' })).toBeVisible();
      await expect(page.getByRole('list', { name: '家庭 AI 服务配置进度' })).toBeVisible();
      await expect(page.locator('.family-model-settings-overview-primary .solid-button')).toBeVisible();
      if (viewport.width >= 768 && viewport.width < 1024) {
        const mainPanelBox = await page.locator('.family-model-settings-main-panel').boundingBox();
        expect(mainPanelBox, '平板端主内容面板应完成布局').not.toBeNull();
        expect(mainPanelBox?.width ?? 0, '平板端主内容不应被双侧栏压缩到不可读宽度').toBeGreaterThanOrEqual(400);
      }
    }
    await expectNoHorizontalOverflow(page);
    await saveVisualReviewScreenshot(page, `${viewport.width}x${viewport.height}-entry.png`);

    const searchNavigation = viewport.width < 768
      ? page.locator('.family-model-settings-mobile-task-list').getByRole('button', { name: '搜索索引', exact: true })
      : page.locator('.family-model-settings-section-rail').getByRole('button', { name: /^搜索索引/ });
    await searchNavigation.click();
    await expect(page.getByRole('heading', { name: '搜索索引', exact: true })).toBeVisible();
    await expect(page.getByRole('region', { name: '搜索模型' }).locator('.family-model-settings-binding-card')).toHaveCount(2);
    await expect(page.getByText('向量模型已锁定。更换 Provider、模型或维度会完整重建搜索索引。')).toBeVisible();
    const replacementButton = page.getByRole('button', { name: '更换向量模型（高风险）' });
    await expect(replacementButton).toBeVisible();
    await expectNoHorizontalOverflow(page);
    await saveVisualReviewScreenshot(page, `${viewport.width}x${viewport.height}-search-index.png`);

    await replacementButton.click();
    await expect(page.getByRole('region', { name: '更换向量模型' }).getByLabel('新的向量模型')).toBeVisible();
    await expectNoHorizontalOverflow(page);
    await saveVisualReviewScreenshot(page, `${viewport.width}x${viewport.height}-search-replacement.png`);
  });
}

test('@p0 @family-model-settings-390x844 @family-model-settings-1440x900 configuration review makes model and price status scannable', async ({ app }) => {
  const { page } = app;
  await openFamilyModelSettings(page);

  if ((page.viewportSize()?.width ?? 0) < 768) {
    await page.locator('.family-model-settings-mobile-task-list')
      .getByRole('button', { name: /^配置检查/ }).click();
  } else {
    await page.locator('.family-model-settings-section-rail')
      .getByRole('button', { name: /^配置检查/ }).click();
  }

  await expect(page.getByRole('heading', { name: '配置状态良好' })).toBeVisible();
  await expect(page.getByText('7 项能力已就绪')).toBeVisible();
  const llmRow = page.getByRole('article', { name: '对话与视觉理解 primary' });
  await expect(llmRow.getByText('家庭主服务 · culina-chat-v1')).toBeVisible();
  await expect(llmRow.getByText('价格已填写')).toBeVisible();
  await expect(llmRow.getByText('3/3 项')).toBeVisible();
  await expect(page.getByText('价格设置可用')).toHaveCount(0);
  await expectNoHorizontalOverflow(page);
  await saveVisualReviewScreenshot(
    page,
    `${page.viewportSize()?.width}x${page.viewportSize()?.height}-configuration-review.png`,
  );
  await llmRow.scrollIntoViewIfNeeded();
  await saveVisualReviewScreenshot(
    page,
    `${page.viewportSize()?.width}x${page.viewportSize()?.height}-configuration-review-models.png`,
  );
});

test.describe('@p0 @family-model-settings-1440x900 workspace navigation contract', () => {
  test.use({ familyModelScenario: 'configured' });

  test('fills the desktop content height and keeps the section rail anchored while content scrolls', async ({ app }) => {
    const { page } = app;
    await openFamilyModelSettings(page);

    const appContent = page.locator('.app-content');
    const workspace = page.locator('.family-model-settings-workspace');
    const sectionRail = page.getByRole('navigation', { name: '家庭 AI 服务设置分区' });
    const [contentBox, workspaceBox, initialRailBox] = await Promise.all([
      appContent.boundingBox(),
      workspace.boundingBox(),
      sectionRail.boundingBox(),
    ]);
    expect(contentBox, '桌面应用内容区应完成布局').not.toBeNull();
    expect(workspaceBox, '家庭 AI 服务工作区应完成布局').not.toBeNull();
    expect(initialRailBox, 'AI 服务分区导航应完成布局').not.toBeNull();
    expect(workspaceBox?.height ?? 0, '短内容分区也应铺满桌面可用高度')
      .toBeGreaterThanOrEqual((contentBox?.height ?? 0) - 1);

    await sectionRail.getByRole('button', { name: /^能力配置/ }).click();
    await expect(page.getByRole('heading', { name: '能力配置', exact: true })).toBeVisible();
    await appContent.evaluate((element) => { element.scrollTop = 240; });
    await expect.poll(() => appContent.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);

    const scrolledRailBox = await sectionRail.boundingBox();
    expect(Math.abs((scrolledRailBox?.y ?? 0) - (initialRailBox?.y ?? 0)), '滚动内容时分区导航不应跳动')
      .toBeLessThanOrEqual(1);
  });

  test('browser back returns a clean workspace to the family profile', async ({ app }) => {
    const { page } = app;
    await openFamilyModelSettings(page);
    await expect.poll(() => page.evaluate(() => window.history.state?.culinaWorkspaceGuard ?? null))
      .toBe('family-model-settings:family-smoke');

    await page.goBack();

    await expect(page.getByRole('heading', { name: '家庭 AI 服务', exact: true })).toHaveCount(0);
    await expect(page.getByRole('heading', { name: '我的家庭', exact: true })).toBeVisible();
  });

  test('page back consumes its workspace history guard before returning to the family profile', async ({ app }) => {
    const { page } = app;
    await page.goto('/?history-origin=family-model-settings', { waitUntil: 'domcontentloaded' });
    await openFamilyModelSettings(page);

    await page.getByRole('button', { name: '返回家庭', exact: true }).click();
    await expect(page.getByRole('heading', { name: '我的家庭', exact: true })).toBeVisible();

    await page.goBack();
    await expect(page).toHaveURL(/history-origin=family-model-settings/);
  });

  test('browser back saves pending configuration changes before leaving', async ({ app }) => {
    const { page } = app;
    await openFamilyModelSettings(page);
    await page.locator('.family-model-settings-section-rail')
      .getByRole('button', { name: /^能力配置/ }).click();
    const llmCard = page.locator('.family-model-settings-binding-card')
      .filter({ hasText: '对话与视觉理解 · 主用' });
    await expandBinding(llmCard);
    const draftRequest = page.waitForRequest((request) => (
      request.method() === 'PUT'
      && new URL(request.url()).pathname === '/api/family/model-settings/draft'
    ));
    await llmCard.getByRole('combobox', { name: '模型名称' }).fill('unsaved-browser-back-model');

    await page.goBack();

    const saved = await draftRequest;
    expect(saved.postDataJSON().bindings.find((binding) => binding.capability === 'llm')?.requested_model)
      .toBe('unsaved-browser-back-model');
    await expect(page.getByRole('heading', { name: '放弃未保存的配置修改？' })).toHaveCount(0);
  });

  test('Escape stays inert while an automatic save is pending', async ({ app }) => {
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
    const llmCard = page.locator('.family-model-settings-binding-card')
      .filter({ hasText: '对话与视觉理解 · 主用' });
    await expandBinding(llmCard);
    const draftRequest = page.waitForRequest((request) => (
      request.method() === 'PUT'
      && new URL(request.url()).pathname === '/api/family/model-settings/draft'
    ));
    await llmCard.getByRole('combobox', { name: '模型名称' }).fill('busy-auto-save-model');
    await draftRequest;
    await expect(page.locator('.family-model-settings-workspace')).toHaveAttribute('aria-busy', 'true');

    await page.keyboard.press('Escape');
    await expect(page.getByRole('heading', { name: '家庭 AI 服务', exact: true })).toBeVisible();

    releaseDraftRequest();
    await expect(page.locator('.family-model-settings-workspace')).not.toHaveAttribute('aria-busy', 'true');
  });
});

test.describe('@p0 model discovery and manual fallback', () => {
  test.use({ familyModelScenario: 'configured' });

  test('@family-model-settings-390x844 @family-model-settings-1440x900 loads Provider models while keeping custom input available', async ({ app }) => {
    const { page } = app;
    await openFamilyModelSettings(page);
    if ((page.viewportSize()?.width ?? 0) < 768) {
      await page.locator('.family-model-settings-mobile-task-list')
        .getByRole('button', { name: '能力配置', exact: true }).click();
    } else {
      await page.locator('.family-model-settings-section-rail')
        .getByRole('button', { name: /^能力配置/ }).click();
    }

    const llmCard = page.locator('.family-model-settings-binding-card')
      .filter({ hasText: '对话与视觉理解 · 主用' });
    await expandBinding(llmCard);
    await expect(llmCard.getByText('已自动读取 7 个模型，也可以直接输入其他模型标识。')).toBeVisible();

    const modelField = llmCard.getByRole('combobox', { name: '模型名称' });
    await modelField.click();
    await expect(page.getByRole('option', { name: 'culina-chat-v2' })).toBeVisible();
    await page.getByRole('option', { name: 'culina-chat-v2' }).click();
    await expect(modelField).toHaveValue('culina-chat-v2');

    await modelField.fill('family-custom-chat');
    await expect(modelField).toHaveValue('family-custom-chat');
    await expect(page.getByRole('option', { name: '使用自定义：family-custom-chat' })).toBeVisible();
    await expectNoHorizontalOverflow(page);
    await saveVisualReviewScreenshot(page, `${page.viewportSize()?.width ?? 0}x${page.viewportSize()?.height ?? 0}-model-combobox.png`);

    const imageCard = page.locator('.family-model-settings-binding-card')
      .filter({ hasText: '图片生成 · 文字生成' });
    await expandBinding(imageCard);
    await imageCard.getByRole('button', { name: '图片尺寸' }).click();
    await expect(page.getByRole('option', { name: /1024 × 1536.*竖版图片/ })).toBeVisible();
    await expectNoHorizontalOverflow(page);
    await saveVisualReviewScreenshot(page, `${page.viewportSize()?.width ?? 0}x${page.viewportSize()?.height ?? 0}-settings-dropdown.png`);
  });
});

test.describe('@p0 @family-model-settings-1440x900 Owner provider credential boundaries', () => {
  test.use({ familyModelScenario: 'configured' });

  test('uses write-only keys only for create and update, while endpoint changes create a new profile', async ({ app }) => {
    const { familyModelRequests, page } = app;
    const createMarker = 'create-key-marker-only-for-request';
    const rotateMarker = 'rotate-key-marker-only-for-request';

    await openFamilyModelSettings(page);
    await page.locator('.family-model-settings-section-rail')
      .getByRole('button', { name: /^Provider 服务/ }).click();
    await page.getByRole('navigation', { name: 'Provider 服务列表' })
      .getByRole('button', { name: /家庭主服务/ }).click();

    await expect(page.getByText('更换连接地址或账号需要创建新服务，再重新绑定能力。')).toBeVisible();
    await expect(page.getByLabel('API 地址')).toHaveCount(0);

    const connectionRequest = page.waitForRequest((request) => (
      request.method() === 'POST'
      && new URL(request.url()).pathname === '/api/family/model-settings/provider-profiles/family-model-profile-http/connection-check'
    ));
    await page.getByRole('button', { name: '检查连接' }).click();
    await connectionRequest;
    await expect(page.getByText('服务连接正常，已读取 7 个模型。')).toBeVisible();

    await page.getByRole('button', { name: '修改 Key' }).click();
    await expect(page.getByLabel('当前密码')).toHaveCount(0);
    await page.getByLabel('新的 API Key').fill(rotateMarker);
    const rotateRequestPromise = page.waitForRequest((request) => (
      request.method() === 'POST'
      && new URL(request.url()).pathname === '/api/family/model-settings/provider-profiles/family-model-profile-http/rotate-key'
    ));
    await page.getByRole('button', { name: '确认修改' }).click();
    const rotateRequest = await rotateRequestPromise;
    expect(rotateRequest.postDataJSON()).toMatchObject({ new_api_key: rotateMarker });
    expect(rotateRequest.postDataJSON()).not.toHaveProperty('current_password');
    await expect(page.getByLabel('新的 API Key')).toHaveCount(0);

    await page.getByLabel('显示名称').fill('家庭主服务（已校验）');
    const patchRequestPromise = page.waitForRequest((request) => (
      request.method() === 'PATCH'
      && new URL(request.url()).pathname === '/api/family/model-settings/provider-profiles/family-model-profile-http'
    ));
    await page.getByRole('button', { name: '保存服务' }).click();
    const patchRequest = await patchRequestPromise;
    expect(patchRequest.postDataJSON()).not.toHaveProperty('api_base_url');
    expect(patchRequest.postDataJSON()).not.toHaveProperty('auth_mode');

    await page.getByRole('button', { name: '新建服务' }).click();
    await page.getByLabel('服务名称').fill('替换服务');
    await page.getByLabel('API 地址').fill('https://replacement.example/v1');
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
    await page.getByRole('button', { name: '创建服务' }).click();
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

test.describe('@p0 @family-model-settings-1440x900 create-and-rebind recovery', () => {
  test.use({ familyModelScenario: 'conflict' });

  test('retries the draft rebind without creating a duplicate Provider profile', async ({ app }) => {
    const { familyModelRequests, page } = app;
    await openFamilyModelSettings(page);
    await page.locator('.family-model-settings-section-rail')
      .getByRole('button', { name: /^Provider 服务/ }).click();
    await page.getByRole('navigation', { name: 'Provider 服务列表' })
      .getByRole('button', { name: /家庭主服务/ }).click();
    await page.getByRole('button', { name: '新建服务' }).click();
    await page.getByLabel('服务名称').fill('替换服务');
    await page.getByLabel('API 地址').fill('https://replacement.example/v1');
    await page.locator('input[type="password"][autocomplete="new-password"]').fill('replacement-recovery-key');
    await page.getByRole('button', { name: '创建服务' }).click();

    const pendingRebindState = page.getByText('新服务已创建，能力改绑未完成', { exact: true });
    await expect(pendingRebindState).toBeVisible();
    expect(familyModelRequests.filter((request) => (
      request.method === 'POST'
      && request.pathname === '/api/family/model-settings/provider-profiles'
    ))).toHaveLength(1);

    await page.getByRole('button', { name: '重试改绑' }).click();
    await expect(pendingRebindState).toHaveCount(0);

    expect(familyModelRequests.filter((request) => (
      request.method === 'POST'
      && request.pathname === '/api/family/model-settings/provider-profiles'
    ))).toHaveLength(1);
    const rebindRequests = familyModelRequests.filter((request) => (
      request.method === 'PUT'
      && request.pathname === '/api/family/model-settings/draft'
    ));
    expect(rebindRequests).toHaveLength(2);
    expect(rebindRequests.map((request) => request.body.base_draft_version_number)).toEqual([4, 5]);
    expect(rebindRequests[1]?.body.change_note).toBe('另一位主理人的并发更新');
  });
});

test.describe('@p0 @family-model-settings-1440x900 Owner configuration and privacy journey', () => {
  test.use({ familyModelScenario: 'configured' });

  test('binds ordinary and search capabilities, changes a price, auto saves and checks completeness', async ({ app }) => {
    const { familyModelRequests, page } = app;
    await openFamilyModelSettings(page);
    await page.locator('.family-model-settings-section-rail')
      .getByRole('button', { name: /^能力配置/ }).click();

    const bindingCards = page.locator('.family-model-settings-binding-card');
    await expect(bindingCards).toHaveCount(5);
    for (const label of ['对话与视觉理解', '图片生成', '语音识别', '语音播报', '实时语音']) {
      await expect(bindingCards.filter({ hasText: label }).getByText('已启用')).toBeVisible();
    }

    await page.locator('.family-model-settings-section-rail')
      .getByRole('button', { name: /^搜索索引/ }).click();
    const searchBindingCards = page.locator('.family-model-settings-binding-card');
    await expect(searchBindingCards).toHaveCount(2);
    for (const label of ['搜索向量', '搜索重排']) {
      await expect(searchBindingCards.filter({ hasText: label }).getByText('已启用')).toBeVisible();
    }
    await page.locator('.family-model-settings-section-rail')
      .getByRole('button', { name: /^能力配置/ }).click();

    const llmCard = bindingCards.filter({ hasText: '对话与视觉理解 · 主用' });
    await expandBinding(llmCard);
    const testCapabilityRequest = page.waitForRequest((request) => (
      request.method() === 'POST'
      && new URL(request.url()).pathname === '/api/family/model-settings/capabilities/llm/test'
    ));
    await llmCard.getByRole('button', { name: '测试能力' }).click();
    await testCapabilityRequest;
    await expect(llmCard.getByRole('button', { name: '测试成功' })).toBeVisible();

    await llmCard.getByRole('combobox', { name: '模型名称' }).fill('culina-chat-v2');
    await page.locator('.family-model-settings-section-rail')
      .getByRole('button', { name: /^模型价格/ }).click();
    const firstPriceCard = page.locator('.family-model-settings-price-card').first();
    await expandPrice(firstPriceCard);
    const saveDraftRequest = page.waitForRequest((request) => (
      request.method() === 'PUT' && new URL(request.url()).pathname === '/api/family/model-settings/draft'
    ));
    await firstPriceCard.getByLabel('未缓存输入 Token 单价').fill('0.120000');
    await saveDraftRequest;
    await expect(page.getByText('配置已自动保存并生效')).toBeVisible();

    await page.locator('.family-model-settings-section-rail')
      .getByRole('button', { name: /^配置检查/ }).click();
    const validateRequest = page.waitForRequest((request) => (
      request.method() === 'POST' && new URL(request.url()).pathname === '/api/family/model-settings/draft/validate'
    ));
    await page.getByRole('button', { name: '重新检查' }).click();
    await validateRequest;
    await expect(page.getByRole('heading', { name: '配置状态良好' })).toBeVisible();

    await expect(page.getByLabel('当前密码')).toHaveCount(0);
    await expect(page.getByRole('button', { name: '发布配置', exact: true })).toHaveCount(0);
    expect(familyModelRequests.some((request) => request.pathname === '/api/family/model-settings/publish')).toBe(false);
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

    test('retains a local edit when automatic save reports a stale configuration conflict', async ({ app }) => {
      const { page } = app;
      await openFamilyModelSettings(page);
      await page.locator('.family-model-settings-section-rail')
        .getByRole('button', { name: /^能力配置/ }).click();
      const llmCard = page.locator('.family-model-settings-binding-card').filter({ hasText: '对话与视觉理解 · 主用' });
      const enabledSwitch = llmCard.getByRole('checkbox').first();
      const conflictResponse = page.waitForResponse((response) => (
        response.request().method() === 'PUT'
        && new URL(response.url()).pathname === '/api/family/model-settings/draft'
        && response.status() === 409
      ));
      await llmCard.locator('.family-model-settings-switch').click();
      await conflictResponse;

      await expect(page.getByRole('alert')).toContainText('配置已在别处更新，请刷新后继续编辑。');
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
      await expandBinding(llmCard);
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

  test('shows a safe button state when a capability test is blocked by the hard limit', async ({ app }) => {
    const { page } = app;
    await openFamilyModelSettings(page);
    await page.locator('.family-model-settings-section-rail')
      .getByRole('button', { name: /^能力配置/ }).click();
    const llmCard = page.locator('.family-model-settings-binding-card').filter({ hasText: '对话与视觉理解 · 主用' });
    await expandBinding(llmCard);
    await llmCard.getByRole('button', { name: '测试能力' }).click();
    await expect(llmCard.getByRole('button', { name: '用量受限，重试' })).toHaveAttribute(
      'title',
      '测试被用量限制阻止，未调用模型。请检查模型用量限制后重试。',
    );
  });
});

test.describe('@family-model-settings-1440x900 search replacement recovery', () => {
  test.use({ familyModelScenario: 'search-failed' });

  test('shows failed replacement, retries it, and reflects activation', async ({ app }) => {
    const { page } = app;
    await openFamilyModelSettings(page);
    await page.locator('.family-model-settings-section-rail')
      .getByRole('button', { name: /^搜索索引/ }).click();
    await page.getByRole('button', { name: '更换向量模型（高风险）' }).click();
    const replacementRegion = page.getByRole('region', { name: '更换向量模型' });
    await replacementRegion.getByRole('button', { name: '新的 Provider 服务' }).click();
    await page.getByRole('option', { name: /家庭主服务/ }).click();
    await replacementRegion.getByLabel('新的向量模型').fill('culina-embedding-v2');
    await replacementRegion.getByLabel('向量维度').fill('2048');
    await replacementRegion.getByRole('button', { name: '评估完整重建' }).click();
    await expect(page.getByText(/预计重建 42 份家庭文档/)).toBeVisible();
    await page.getByLabel('当前密码').fill('owner-password');
    await page.getByLabel('我确认更换向量身份，并理解系统会完整重建搜索索引。').check();
    await page.getByRole('button', { name: '确认并开始重建' }).click();
    await expect(page.getByText('索引建立失败，现有可用索引没有被替换。')).toBeVisible();

    await page.getByRole('button', { name: '重试建立索引' }).click();
    await expect(page.getByRole('heading', { name: '替换索引进度' })).toHaveCount(0);
    await expect(page.getByText('当前搜索索引已启用')).toBeVisible();
  });
});

test.describe('@family-model-settings-390x844 search cancellation and Member privacy', () => {
  test.use({ familyModelScenario: 'search-cancelled' });

  test('allows a provisioning replacement to be cancelled without replacing the active index', async ({ app }) => {
    const { page } = app;
    await openFamilyModelSettings(page);
    await page.locator('.family-model-settings-mobile-task-list')
      .getByRole('button', { name: '搜索索引', exact: true }).click();
    await page.getByRole('button', { name: '更换向量模型（高风险）' }).click();
    const replacementRegion = page.getByRole('region', { name: '更换向量模型' });
    await replacementRegion.getByRole('button', { name: '新的 Provider 服务' }).click();
    await page.getByRole('option', { name: /家庭主服务/ }).click();
    await replacementRegion.getByLabel('新的向量模型').fill('culina-embedding-v2');
    await replacementRegion.getByLabel('向量维度').fill('2048');
    await replacementRegion.getByRole('button', { name: '评估完整重建' }).click();
    await page.getByLabel('当前密码').fill('owner-password');
    await page.getByLabel('我确认更换向量身份，并理解系统会完整重建搜索索引。').check();
    await page.getByRole('button', { name: '确认并开始重建' }).click();
    await expect(page.getByText('正在完整建立索引，可继续使用当前可用的搜索方式。')).toBeVisible();
    await page.getByRole('button', { name: '取消重建' }).click();
    await expect(page.getByRole('heading', { name: '替换索引进度' })).toHaveCount(0);
    await expect(page.getByText('当前搜索索引已启用')).toBeVisible();
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
