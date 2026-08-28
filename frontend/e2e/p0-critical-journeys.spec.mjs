import { expect, test } from './fixtures/p0App.mjs';

async function expectNoHorizontalOverflow(page) {
  const overflow = await page.evaluate(
    () => Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - window.innerWidth,
  );
  expect(overflow, '页面不应产生横向溢出').toBeLessThanOrEqual(1);
}

async function attachCheckpointScreenshot(page, testInfo, name) {
  await testInfo.attach(name, {
    body: await page.screenshot({
      animations: 'disabled',
      caret: 'hide',
    }),
    contentType: 'image/png',
  });
}

async function stabilizeDarwinVisualGutter(page) {
  if (process.platform === 'darwin') {
    await page.addStyleTag({ content: 'html, .app-content { scrollbar-gutter: auto !important; }' });
  }
}

const AI_CONVERSATION_ID = 'conversation-auto-execution';
const AI_AVAILABLE_DEADLINE = '2026-08-24T11:00:00.000Z';
const AI_FRESH_SERVER_NOW = '2026-08-24T10:30:00.000Z';
const AI_STORED_SERVER_NOW = '2026-08-24T09:30:00.000Z';
const AI_AUTO_OPERATION_ID = 'operation-auto-favorite';
const AI_AUTO_EXECUTION_ACTION_KEYS = [
  'food.set_favorite',
  'meal_log.rate_food',
  'shopping_list.safe_write',
  'meal_log.simple_create',
  'meal_plan.simple_create',
];

function copyJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function aiAutoExecutionSettingsFixture() {
  return {
    catalog_version: 'auto-execution-catalog.v1',
    consent_notice: {
      version: 'auto-execution-consent.v2',
      acknowledged: true,
    },
    member_preferences: AI_AUTO_EXECUTION_ACTION_KEYS.map((actionKey, index) => ({
      action_key: actionKey,
      enabled: actionKey !== 'food.set_favorite' && actionKey !== 'meal_log.rate_food',
      effective_enabled: actionKey !== 'food.set_favorite' && actionKey !== 'meal_log.rate_food',
      row_version: index + 1,
      consent_notice_version: 'auto-execution-consent.v2',
      requires_reconsent: actionKey === 'meal_log.rate_food',
    })),
    family_policies: [{
      action_key: 'shopping_list.safe_write',
      enabled: true,
      effective_enabled: true,
      row_version: 3,
      consent_notice_version: 'auto-execution-consent.v2',
      requires_reconsent: false,
    }],
    limits: {
      'meal_log.rate_food': { max_entries: 5 },
      'shopping_list.safe_write': { max_create_items: 5, max_update_items: 1 },
      'meal_log.simple_create': { max_foods: 5 },
      'meal_plan.simple_create': { max_items: 5 },
    },
    server_now: AI_FRESH_SERVER_NOW,
  };
}

function operationResultCardFixture({
  draftId,
  title,
  explanation,
  executionMode = 'policy_auto',
  resultStatus = 'completed',
  operationStatus = 'completed',
  revertAvailability = 'available',
  revertBlockedCode = null,
  operationId = `operation-${draftId}`,
  revertibleUntil = AI_AVAILABLE_DEADLINE,
  serverNow = AI_STORED_SERVER_NOW,
  entities = [{
    id: `food-${draftId}`,
    label: '食物',
    operation: 'food',
    operationLabel: '收藏',
    updatedAt: '2026-08-24T10:00:00.000Z',
  }],
}) {
  return {
    id: `operation-result:${draftId}`,
    type: 'operation_result',
    title,
    data: {
      draft_id: draftId,
      operation_id: operationId,
      result_status: resultStatus,
      execution_mode: executionMode,
      operation_status: operationStatus,
      execution_explanation: explanation,
      revert_availability: revertAvailability,
      revertible_until: revertibleUntil,
      revert_blocked_code: revertBlockedCode,
      server_now: serverNow,
      entities,
      cache_scopes: ['food', 'ai_conversation'],
      actionSummary: explanation,
      entityCount: entities.length,
      entityCountLabel: `${entities.length} 个项目`,
      workspaceLabel: '食物库',
      workspaceHint: entities.length > 0 ? '可前往食物库查看' : '',
    },
  };
}

function aiStoredOperationCards() {
  return [
    operationResultCardFixture({
      draftId: 'draft-auto',
      operationId: AI_AUTO_OPERATION_ID,
      title: '自动收藏结果',
      explanation: '已按规则自动收藏番茄炒蛋。',
    }),
    operationResultCardFixture({
      draftId: 'draft-manual',
      title: '人工确认结果',
      explanation: '已按你的确认更新收藏状态。',
      executionMode: 'manual_approval',
    }),
    operationResultCardFixture({
      draftId: 'draft-no-change',
      title: '无需重复修改',
      explanation: '相关内容已经是你要求的状态。',
      executionMode: 'policy_no_change',
      resultStatus: 'no_change',
      operationStatus: null,
      revertAvailability: 'unsupported',
      operationId: null,
      revertibleUntil: null,
      entities: [],
    }),
    operationResultCardFixture({
      draftId: 'draft-failed',
      title: '自动执行失败',
      explanation: '本次操作未完成，请稍后重试。',
      resultStatus: 'failed',
      operationStatus: 'failed',
      revertAvailability: 'unsupported',
      operationId: null,
      revertibleUntil: null,
      entities: [],
    }),
    operationResultCardFixture({
      draftId: 'draft-expired',
      title: '已过撤销时间',
      explanation: '收藏状态已更新。',
      revertAvailability: 'expired',
      revertibleUntil: '2026-08-24T10:00:00.000Z',
    }),
    operationResultCardFixture({
      draftId: 'draft-blocked',
      title: '撤销已阻止',
      explanation: '收藏状态已更新。',
      revertAvailability: 'blocked',
      revertBlockedCode: 'revert_target_changed',
    }),
    operationResultCardFixture({
      draftId: 'draft-reverted',
      title: '历史撤销结果',
      explanation: '收藏状态已恢复。',
      resultStatus: 'reverted',
      operationStatus: 'reverted',
      revertAvailability: 'reverted',
    }),
  ];
}

function revertedAutoOperationCard() {
  return operationResultCardFixture({
    draftId: 'draft-auto',
    operationId: AI_AUTO_OPERATION_ID,
    title: '自动收藏结果',
    explanation: '收藏状态已恢复。',
    resultStatus: 'reverted',
    operationStatus: 'reverted',
    revertAvailability: 'reverted',
  });
}

function operationProjectionFromCard(card) {
  const data = card.data;
  return {
    draft_id: data.draft_id,
    operation_id: data.operation_id,
    result_status: data.result_status,
    execution_mode: data.execution_mode,
    operation_status: data.operation_status,
    execution_explanation: data.execution_explanation,
    revert_availability: data.revert_availability,
    revertible_until: data.revertible_until,
    revert_blocked_code: data.revert_blocked_code,
    server_now: data.server_now,
    entities: data.entities,
    cache_scopes: data.cache_scopes,
  };
}

function hydrateOperationCard(card, serverNow = AI_FRESH_SERVER_NOW) {
  const hydrated = copyJson(card);
  hydrated.data.server_now = serverNow;
  if (
    hydrated.data.revert_availability === 'available'
    && Date.parse(serverNow) > Date.parse(hydrated.data.revertible_until)
  ) {
    hydrated.data.revert_availability = 'expired';
  }
  return hydrated;
}

function operationMessageFixture(card, index) {
  return {
    id: `message-operation-${index + 1}`,
    conversation_id: AI_CONVERSATION_ID,
    role: 'assistant',
    content: '',
    content_type: 'parts',
    parts: [{
      id: `operation-result-part:${card.data.draft_id}`,
      type: 'result_card',
      status: 'completed',
      card,
    }],
    status: 'completed',
    metadata: {},
    created_at: `2026-08-24T10:${String(index).padStart(2, '0')}:00.000Z`,
  };
}

async function fulfillAiJson(route, body, status = 200) {
  await route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  });
}

async function installAiAutoExecutionMocks(routingContext) {
  const storedCards = aiStoredOperationCards();
  const revertRequestBodies = [];
  const unexpectedRequests = [];
  let reverted = false;
  let hydratedServerNow = AI_FRESH_SERVER_NOW;
  let messagesRequestCount = 0;

  await routingContext.route('**/api/ai/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();

    if (method === 'GET' && url.pathname === '/api/ai/status') {
      await fulfillAiJson(route, {
        configured: true,
        enabled: true,
        supports_vision: true,
        status: 'ready',
        detail: 'AI 已就绪。',
        capabilities: {
          llm: 'available',
          embedding: 'available',
          rerank: 'available',
          stt: 'available',
          tts: 'available',
          realtime_audio: 'available',
          image_generation: 'available',
        },
      });
      return;
    }

    if (method === 'GET' && url.pathname === '/api/ai/conversations') {
      await fulfillAiJson(route, [{
        id: AI_CONVERSATION_ID,
        family_id: 'family-smoke',
        owner_user_id: 'user-smoke',
        owner_display_name: 'Smoke User',
        visibility: 'private',
        is_owner: true,
        mode: 'recommendation',
        prompt: '自动执行验收',
        response: '已完成验收夹具。',
        created_at: '2026-08-24T10:00:00.000Z',
        created_by: 'user-smoke',
        context: {},
        title: '自动执行验收',
        summary: '覆盖自动执行与撤销卡片。',
        status: 'completed',
        last_message_at: '2026-08-24T10:06:00.000Z',
        last_run_status: 'completed',
      }]);
      return;
    }

    if (method === 'GET' && url.pathname === `/api/ai/conversations/${AI_CONVERSATION_ID}/messages`) {
      messagesRequestCount += 1;
      const cards = storedCards.map((card) => (
        reverted && card.data.draft_id === 'draft-auto' ? revertedAutoOperationCard() : card
      ));
      await fulfillAiJson(route, cards.map((card, index) => operationMessageFixture(
        hydrateOperationCard(card, hydratedServerNow),
        index,
      )));
      return;
    }

    if (method === 'GET' && url.pathname === `/api/ai/conversations/${AI_CONVERSATION_ID}/approvals/pending`) {
      await fulfillAiJson(route, []);
      return;
    }

    if (method === 'GET' && url.pathname === '/api/ai/auto-execution/settings') {
      await fulfillAiJson(route, aiAutoExecutionSettingsFixture());
      return;
    }

    if (method === 'POST' && url.pathname === `/api/ai/operations/${AI_AUTO_OPERATION_ID}/revert`) {
      const body = request.postDataJSON();
      expect(Object.keys(body)).toEqual(['client_request_id']);
      expect(body.client_request_id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      );
      revertRequestBodies.push(body);
      reverted = true;
      const resultCard = hydrateOperationCard(revertedAutoOperationCard(), hydratedServerNow);
      expect(resultCard.id).toBe('operation-result:draft-auto');
      await fulfillAiJson(route, {
        projection: operationProjectionFromCard(resultCard),
        result_card: resultCard,
        cache_scopes: ['food', 'ai_conversation'],
        server_now: hydratedServerNow,
        replayed: false,
      });
      return;
    }

    unexpectedRequests.push(`${method} ${url.pathname}${url.search}`);
    await fulfillAiJson(route, { detail: `Unhandled AI acceptance request: ${url.pathname}` }, 404);
  });

  return {
    storedServerNow: AI_STORED_SERVER_NOW,
    revertRequestBodies,
    unexpectedRequests,
    get hydratedServerNow() {
      return hydratedServerNow;
    },
    get messagesRequestCount() {
      return messagesRequestCount;
    },
    setHydratedServerNow(value) {
      hydratedServerNow = value;
    },
  };
}

function acceptanceViewportOverride() {
  const value = process.env.CULINA_AI_ACCEPTANCE_VIEWPORT;
  if (!value) return null;
  const match = /^(\d+)x(\d+)$/.exec(value);
  if (!match) throw new Error(`Invalid CULINA_AI_ACCEPTANCE_VIEWPORT: ${value}`);
  return { width: Number(match[1]), height: Number(match[2]) };
}

async function applyAcceptanceViewport(page) {
  const override = acceptanceViewportOverride();
  if (override) await page.setViewportSize(override);
  const viewport = page.viewportSize();
  if (!viewport) throw new Error('AI acceptance requires a fixed viewport');
  return viewport;
}

async function maybeAttachAiAcceptanceScreenshot(page, testInfo, name, viewport) {
  if (process.env.CULINA_AI_ACCEPTANCE_SCREENSHOTS !== '1') return;
  await attachCheckpointScreenshot(page, testInfo, `${name}-${viewport.width}x${viewport.height}`);
}

async function maybeAttachAiAcceptanceLocatorScreenshot(locator, testInfo, name, viewport) {
  if (process.env.CULINA_AI_ACCEPTANCE_SCREENSHOTS !== '1') return;
  await locator.scrollIntoViewIfNeeded();
  await expect(locator).toBeVisible();
  await testInfo.attach(`${name}-${viewport.width}x${viewport.height}`, {
    body: await locator.screenshot({ animations: 'disabled', caret: 'hide' }),
    contentType: 'image/png',
  });
}

async function openAiWorkspace(page) {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'AI', exact: true }).first().click();
  await expect(page.locator('.ai-workspace-shell')).toBeAttached();
}

async function expectMobileAutoExecutionTriggerGeometry(page) {
  const trigger = page.getByRole('button', { name: 'AI 自动执行设置' });
  await expect(trigger).toBeVisible();
  const box = await trigger.boundingBox();
  expect(box).not.toBeNull();
  expect(box.width).toBeGreaterThanOrEqual(44);
  expect(box.height).toBeGreaterThanOrEqual(44);
  const topbarOverflow = await page.locator('.ai-mobile-topbar').evaluate(
    (element) => element.scrollWidth - element.clientWidth,
  );
  expect(topbarOverflow, 'AI 手机顶栏不应横向溢出').toBeLessThanOrEqual(1);
  await expectNoHorizontalOverflow(page);
}

async function openAiAutoExecutionSettings(page, isPhone) {
  if (isPhone) {
    await page.getByRole('button', { name: 'AI 自动执行设置' }).click();
  } else {
    await page.locator('.ai-auto-execution-header-button').click();
  }
  const root = page.locator(isPhone
    ? '.ai-auto-execution-mobile-page'
    : '.ai-auto-execution-desktop-panel');
  await expect(root).toBeVisible();
  await expect(root.getByRole('heading', { name: '我的自动执行' })).toBeVisible();
  return root;
}

async function expectSettingsGeometry(settingsRoot, page, viewport, isPhone) {
  const settingsBox = await settingsRoot.boundingBox();
  expect(settingsBox).not.toBeNull();
  if (isPhone) {
    expect(Math.abs(settingsBox.x)).toBeLessThanOrEqual(1);
    expect(Math.abs(settingsBox.y)).toBeLessThanOrEqual(1);
    expect(settingsBox.width).toBeGreaterThanOrEqual(viewport.width - 1);
    expect(settingsBox.height).toBeGreaterThanOrEqual(viewport.height - 1);
    return;
  }
  const workspaceBox = await page.locator('.ai-workspace-shell').boundingBox();
  expect(workspaceBox).not.toBeNull();
  expect(await page.locator('.ai-workspace-shell').evaluate(
    (workspace, panel) => workspace.contains(panel),
    await settingsRoot.elementHandle(),
  )).toBe(true);
  expect(settingsBox.x).toBeGreaterThanOrEqual(workspaceBox.x - 1);
  expect(settingsBox.y).toBeGreaterThanOrEqual(workspaceBox.y - 1);
  expect(settingsBox.x + settingsBox.width).toBeLessThanOrEqual(
    workspaceBox.x + workspaceBox.width + 1,
  );
}

async function expectOwnerSwitchAccessibility(settingsRoot, page) {
  const switches = settingsRoot.getByRole('switch');
  await expect(switches).toHaveCount(6);
  const controls = await switches.all();
  for (const control of controls) {
    await expect(control).toBeEnabled();
    const metrics = await control.evaluate((element) => {
      const box = element.getBoundingClientRect();
      return { width: box.width, height: box.height, tabIndex: element.tabIndex };
    });
    expect(metrics.width).toBeGreaterThanOrEqual(44);
    expect(metrics.height).toBeGreaterThanOrEqual(44);
    expect(metrics.tabIndex).toBe(0);
  }
  await controls[0].focus();
  for (let index = 0; index < controls.length; index += 1) {
    await expect(controls[index]).toBeFocused();
    if (index < controls.length - 1) await page.keyboard.press('Tab');
  }
}

function visibleAiConversationSurface(page, isPhone) {
  return page.locator(isPhone ? '.ai-mobile-page' : '.ai-main-panel');
}

function operationCardByTitle(surface, title) {
  return surface.locator('.ai-operation-result-card').filter({ hasText: title });
}

test.describe('P0 unauthenticated entry', () => {
  test.use({ authenticated: false });

  test('@p0 signs in and restores the family kitchen session', async ({ app, context }, testInfo) => {
    const { page } = app;

    await page.goto('/', { waitUntil: 'domcontentloaded' });

    await expect(page.getByRole('heading', { name: '登录家庭厨房' })).toBeVisible();
    await expect(page.getByRole('button', { name: '进入家庭厨房' })).toBeVisible();
    await expectNoHorizontalOverflow(page);
    await stabilizeDarwinVisualGutter(page);
    await expect(page.locator('.login-card')).toHaveScreenshot('login-card.png');
    await attachCheckpointScreenshot(page, testInfo, 'checkpoint-login-entry');

    const loginRequestPromise = page.waitForRequest(
      (request) => request.method() === 'POST' && new URL(request.url()).pathname === '/api/auth/login',
    );
    await page.getByLabel('用户名').fill('smoke');
    await page.getByLabel('密码').fill('p0-password');
    await page.getByRole('button', { name: '进入家庭厨房' }).click();

    const loginRequest = await loginRequestPromise;
    expect(loginRequest.postDataJSON()).toEqual({
      username: 'smoke',
      password: 'p0-password',
    });
    await expect(page.getByRole('heading', { name: '今天吃什么' })).toBeVisible();
    expect(await page.evaluate(() => localStorage.getItem('culina-access-token'))).toBeNull();
    const refreshCookie = (await context.cookies()).find((cookie) => cookie.name === 'culina-refresh');
    expect(refreshCookie).toMatchObject({
      httpOnly: true,
      path: '/api/auth',
      sameSite: 'Strict',
    });

    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('heading', { name: '今天吃什么' })).toBeVisible();
  });
});

test.describe('P0 authenticated family workflow', () => {
  test('@p0 AI automatic execution settings and revert card are responsive', async ({ app, context }, testInfo) => {
    const { page } = app;
    const viewport = await applyAcceptanceViewport(page);
    const isPhone = viewport.width < 768;
    await page.clock.install({ time: new Date(AI_FRESH_SERVER_NOW) });
    const aiMocks = await installAiAutoExecutionMocks(context);

    await openAiWorkspace(page);
    if (isPhone) await expectMobileAutoExecutionTriggerGeometry(page);
    const settingsRoot = await openAiAutoExecutionSettings(page, isPhone);

    await expectSettingsGeometry(settingsRoot, page, viewport, isPhone);
    await expect(settingsRoot.getByRole('switch', { name: '收藏状态' })).toHaveAttribute(
      'aria-checked',
      'false',
    );
    await expect(settingsRoot.getByRole('switch', { name: '购物清单安全操作' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    await expect(settingsRoot.getByRole('switch', {
      name: '允许家庭成员在规则内自动维护购物清单',
    })).toHaveAttribute('aria-checked', 'true');
    await expectOwnerSwitchAccessibility(settingsRoot, page);
    await expectNoHorizontalOverflow(page);
    await maybeAttachAiAcceptanceScreenshot(page, testInfo, 'ai-auto-execution-owner-settings', viewport);

    await settingsRoot.getByRole('switch', { name: '餐食评分' }).click();
    const consentDialog = page.getByRole('dialog', { name: '开启自动执行' });
    await expect(consentDialog).toBeVisible();
    await expect(consentDialog).toContainText(
      '只有在你明确要求、目标唯一且符合已开启的低风险规则时才会直接执行；其他情况仍会请你确认。支持撤销的操作可在 1 小时内恢复。',
    );
    await maybeAttachAiAcceptanceScreenshot(page, testInfo, 'ai-auto-execution-owner-consent', viewport);
    await consentDialog.locator('footer').getByRole('button', { name: '取消' }).click();

    await settingsRoot.getByRole('button', { name: isPhone ? '返回' : '返回对话' }).click();
    const conversationSurface = visibleAiConversationSurface(page, isPhone);
    await expect(conversationSurface).toBeVisible();
    await expect(conversationSurface.locator('.ai-operation-result-card')).toHaveCount(7);

    const automaticCard = operationCardByTitle(conversationSurface, '自动收藏结果');
    const manualCard = operationCardByTitle(conversationSurface, '人工确认结果');
    const noChangeCard = operationCardByTitle(conversationSurface, '无需重复修改');
    const failedCard = operationCardByTitle(conversationSurface, '自动执行失败');
    const expiredCard = operationCardByTitle(conversationSurface, '已过撤销时间');
    const blockedCard = operationCardByTitle(conversationSurface, '撤销已阻止');
    const revertedCard = operationCardByTitle(conversationSurface, '历史撤销结果');

    await expect(automaticCard.locator('.ai-query-card-eyebrow')).toHaveText('已自动执行');
    await expect(automaticCard.getByText('可在 1 小时内撤销', { exact: true })).toBeVisible();
    await expect(manualCard.locator('.ai-query-card-eyebrow')).toHaveText('已按你的确认执行');
    await expect(noChangeCard.locator('.ai-query-card-eyebrow')).toHaveText('已是目标状态');
    await expect(noChangeCard).toContainText('相关内容已经是你要求的状态。');
    await expect(failedCard.locator('.ai-query-card-eyebrow')).toHaveText('未完成操作');
    await expect(failedCard).toContainText('本次操作未完成');
    await expect(expiredCard).toContainText('撤销时间已过，可前往页面修改');
    await expect(blockedCard).toContainText('相关内容后来被修改，无法安全撤销');
    await expect(revertedCard).toContainText('操作已撤销');

    for (const [name, card] of [
      ['automatic', automaticCard],
      ['manual', manualCard],
      ['no-change', noChangeCard],
      ['failed', failedCard],
      ['expired', expiredCard],
      ['blocked', blockedCard],
      ['reverted', revertedCard],
    ]) {
      await maybeAttachAiAcceptanceLocatorScreenshot(
        card,
        testInfo,
        `ai-operation-result-${name}`,
        viewport,
      );
    }

    await automaticCard.scrollIntoViewIfNeeded();
    const automaticActions = automaticCard.locator('.ai-operation-result-actions');
    const revertButton = automaticCard.getByRole('button', { name: '撤销', exact: true });
    await expect(revertButton).toBeInViewport();
    if (isPhone) {
      const actionsBox = await automaticActions.boundingBox();
      expect(actionsBox).not.toBeNull();
      const actionButtons = await automaticActions.getByRole('button').all();
      await expect(automaticActions.getByRole('button')).toHaveCount(3);
      let previousY = null;
      for (const button of actionButtons) {
        const buttonBox = await button.boundingBox();
        expect(buttonBox).not.toBeNull();
        expect(buttonBox.x).toBeGreaterThanOrEqual(actionsBox.x - 1);
        expect(buttonBox.x + buttonBox.width).toBeLessThanOrEqual(actionsBox.x + actionsBox.width + 1);
        if (previousY !== null) expect(buttonBox.y).toBeGreaterThan(previousY);
        previousY = buttonBox.y;
      }
    }
    await expectNoHorizontalOverflow(page);
    await maybeAttachAiAcceptanceScreenshot(page, testInfo, 'ai-operation-result-cards', viewport);

    const cardCountBeforeRevert = await conversationSurface.locator('.ai-operation-result-card').count();
    await revertButton.click();
    const completedRevertButton = automaticCard.getByRole('button', { name: '已撤销' });
    await expect(completedRevertButton).toBeVisible();
    await expect(completedRevertButton).toBeFocused();
    await expect(completedRevertButton).toHaveAttribute('aria-disabled', 'true');
    await expect(automaticCard.locator('.ai-query-card-eyebrow')).toHaveText('已撤销');
    await expect(conversationSurface.locator('.ai-operation-result-card')).toHaveCount(cardCountBeforeRevert);
    expect(aiMocks.revertRequestBodies).toHaveLength(1);
    await maybeAttachAiAcceptanceLocatorScreenshot(
      automaticCard,
      testInfo,
      'ai-operation-result-http-reverted',
      viewport,
    );
    await maybeAttachAiAcceptanceScreenshot(
      page,
      testInfo,
      'ai-operation-result-http-reverted-context',
      viewport,
    );

    const deadlineBeforeRefresh = await manualCard.locator('.ai-operation-result-status strong').innerText();
    expect(deadlineBeforeRefresh).toBe('可撤销至 19:00');

    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: 'AI', exact: true }).first().click();
    const refreshedSurface = visibleAiConversationSurface(page, isPhone);
    const refreshedManualCard = operationCardByTitle(refreshedSurface, '人工确认结果');
    await expect(refreshedManualCard.locator('.ai-operation-result-status strong')).toHaveText(
      deadlineBeforeRefresh,
    );
    await expect(operationCardByTitle(refreshedSurface, '自动收藏结果').locator('.ai-query-card-eyebrow')).toHaveText('已撤销');
    expect(aiMocks.messagesRequestCount).toBeGreaterThanOrEqual(2);
    expect(aiMocks.storedServerNow).not.toBe(aiMocks.hydratedServerNow);

    aiMocks.setHydratedServerNow('2026-08-24T11:00:00.001Z');
    await page.clock.fastForward(30 * 60 * 1000 + 1);
    await expect(refreshedManualCard).toContainText('撤销时间已过，可前往页面修改');
    await expect(refreshedManualCard.getByRole('button', { name: '撤销', exact: true })).toHaveCount(0);
    await expectNoHorizontalOverflow(page);
    expect(aiMocks.unexpectedRequests).toEqual([]);
  });

  test('@p0 navigates family surfaces and records a planned meal', async ({ app }, testInfo) => {
    const { page, requestedApiPaths } = app;
    const isPhone = testInfo.project.name === 'phone-375x812';

    await page.clock.setFixedTime(new Date('2026-07-12T09:00:00+08:00'));
    await page.goto('/', { waitUntil: 'domcontentloaded' });

    const homeSurface = page.locator(isPhone ? '.mobile-dashboard-page' : '.dashboard-page');
    await expect(homeSurface.getByRole('heading', { name: '今天吃什么' })).toBeVisible();
    await expect(homeSurface.getByRole('heading', { name: '今天需要处理什么' })).toBeVisible();
    await expect(homeSurface.getByRole('heading', { name: '家里发生了什么' })).toBeVisible();
    await expect
      .poll(() => requestedApiPaths.includes('/api/activity-highlights'))
      .toBe(true);
    expect(requestedApiPaths).not.toContain('/api/activity-logs');
    await expect(page.getByRole('button', { name: /查看通知.*需要处理/ })).toBeVisible();
    await expectNoHorizontalOverflow(page);
    await stabilizeDarwinVisualGutter(page);
    await expect(page).toHaveScreenshot('family-home.png', { timeout: 15_000 });
    await attachCheckpointScreenshot(page, testInfo, 'checkpoint-family-home');

    await page.getByRole('button', { name: '吃什么' }).first().click();
    if (isPhone) {
      await expect(page.locator('.mobile-food-page')).toBeVisible();
      await expect(page.locator('.mobile-food-page').getByRole('heading', { name: '吃什么' })).toBeVisible();
    } else {
      await expect(page.getByText('食物库', { exact: true }).first()).toBeVisible();
    }

    await page.getByRole('button', { name: '食材' }).first().click();
    if (isPhone) {
      await expect(page.locator('.mobile-ingredient-page')).toBeVisible();
      await expect(page.locator('.mobile-ingredient-page').getByRole('heading', { name: '食材' })).toBeVisible();
    } else {
      await expect(page.getByText('管理家庭食材、库存和采购清单。', { exact: true })).toBeVisible();
    }
    await expectNoHorizontalOverflow(page);
    await attachCheckpointScreenshot(page, testInfo, 'checkpoint-ingredient-page');

    await page.getByRole('button', { name: '吃什么' }).first().click();
    if (isPhone) {
      await page.locator('.food-mobile-view').getByRole('button', { name: '用餐记录' }).click();
      await expect(page.locator('.mobile-log-page')).toBeVisible();
      await page.locator('.mobile-log-primary-cta').click();
    } else {
      await page.locator('.food-workspace .hero-actions').getByRole('button', { name: '用餐记录' }).click();
      await expect(page.getByText('家庭时间线', { exact: true })).toBeVisible();
      await page.locator('.meal-log-header-actions').getByRole('button', { name: '记一餐' }).click();
    }

    const mealComposer = page.locator('.meal-composer-modal');
    await expect(mealComposer).toBeVisible();
    await expect(mealComposer.getByRole('heading', { name: '确认时间' })).toBeVisible();
    await expect(mealComposer.getByRole('heading', { name: '添加食物' })).toBeVisible();
    await expect(mealComposer).toHaveScreenshot('meal-composer.png', { timeout: 15_000 });
    await attachCheckpointScreenshot(page, testInfo, 'checkpoint-meal-composer');

    const foodSearch = mealComposer.getByRole('searchbox', { name: '搜索食物' });
    await foodSearch.fill('番茄');
    const searchResults = mealComposer.getByRole('listbox', { name: '食物搜索结果' });
    await expect(searchResults).toBeVisible();
    await searchResults.getByRole('option', { name: /番茄炒蛋/ }).click();
    await expect(mealComposer.getByRole('listitem').filter({ hasText: '番茄炒蛋' })).toBeVisible();

    const isMealRecordRequest = (request) =>
      request.method() === 'POST' && new URL(request.url()).pathname === '/api/meal-logs/record';
    const [recordRequest, recordResponse] = await Promise.all([
      page.waitForRequest(isMealRecordRequest),
      page.waitForResponse(
        (response) => isMealRecordRequest(response.request()) && response.ok(),
      ),
      mealComposer.getByRole('button', { name: '记下这餐' }).click(),
    ]);
    expect(recordResponse.ok()).toBe(true);
    const recordPayload = recordRequest.postDataJSON();
    expect(recordPayload).toMatchObject({
      date: '2026-07-12',
      target: { kind: 'new' },
    });
    expect(recordPayload.entries).toEqual(
      expect.arrayContaining([{ food_id: 'food-egg', servings: 1 }]),
    );
    expect(recordPayload.client_request_id).toEqual(expect.any(String));
    expect(['breakfast', 'lunch', 'dinner', 'snack']).toContain(recordPayload.meal_type);

    await expect(mealComposer).toBeHidden();
    const recordResult = page.locator('.meal-record-result-bar:visible').first();
    await expect(recordResult).toBeVisible();
    await expect(recordResult.getByText('已记下', { exact: true })).toBeVisible();
    await expect(recordResult).toContainText('番茄炒蛋');
    await expectNoHorizontalOverflow(page);
  });
});

test.describe('P0 authenticated Member AI policy', () => {
  test.use({ modelUsageScenario: 'member' });

  test('@p0 AI automatic execution settings and revert card keep Member family policy read-only', async ({ app, context }, testInfo) => {
    const { page } = app;
    const viewport = await applyAcceptanceViewport(page);
    const isPhone = viewport.width < 768;
    await page.clock.install({ time: new Date(AI_FRESH_SERVER_NOW) });
    const aiMocks = await installAiAutoExecutionMocks(context);

    await openAiWorkspace(page);
    if (isPhone) await expectMobileAutoExecutionTriggerGeometry(page);
    const settingsRoot = await openAiAutoExecutionSettings(page, isPhone);
    await expectSettingsGeometry(settingsRoot, page, viewport, isPhone);

    const personalShopping = settingsRoot.getByRole('switch', { name: '购物清单安全操作' });
    await expect(personalShopping).toBeEnabled();
    await expect(personalShopping).toHaveAttribute('aria-checked', 'true');

    const familyShopping = settingsRoot.getByRole('switch', {
      name: '允许家庭成员在规则内自动维护购物清单',
    });
    await expect(familyShopping).toBeDisabled();
    await expect(familyShopping).toHaveAttribute('aria-checked', 'true');
    await expect(settingsRoot.getByText('仅家庭 Owner 可修改', { exact: true })).toBeVisible();
    const familySwitchBox = await familyShopping.boundingBox();
    expect(familySwitchBox).not.toBeNull();
    expect(familySwitchBox.width).toBeGreaterThanOrEqual(44);
    expect(familySwitchBox.height).toBeGreaterThanOrEqual(44);

    await familyShopping.scrollIntoViewIfNeeded();
    await expectNoHorizontalOverflow(page);
    await maybeAttachAiAcceptanceScreenshot(page, testInfo, 'ai-auto-execution-member-family-policy', viewport);
    expect(aiMocks.unexpectedRequests).toEqual([]);
  });
});
