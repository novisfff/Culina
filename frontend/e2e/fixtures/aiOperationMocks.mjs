const AI_CONVERSATION_ID = 'conversation-auto-execution';
const AI_AVAILABLE_DEADLINE = '2026-08-24T11:00:00.000Z';
export const AI_FRESH_SERVER_NOW = '2026-08-24T10:30:00.000Z';
const AI_STORED_SERVER_NOW = '2026-08-24T09:30:00.000Z';
const AI_AUTO_OPERATION_ID = 'operation-auto-favorite';

function copyJson(value) {
  return JSON.parse(JSON.stringify(value));
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

export async function installAiAutoExecutionMocks(routingContext, unexpectedRequests) {
  const storedCards = aiStoredOperationCards();
  const revertRequestBodies = [];
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

    if (method === 'POST' && url.pathname === `/api/ai/operations/${AI_AUTO_OPERATION_ID}/revert`) {
      const body = request.postDataJSON();
      revertRequestBodies.push(body);
      reverted = true;
      const resultCard = hydrateOperationCard(revertedAutoOperationCard(), hydratedServerNow);
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
    revertRequestBodies,
    get messagesRequestCount() {
      return messagesRequestCount;
    },
    setHydratedServerNow(value) {
      hydratedServerNow = value;
    },
  };
}
