import { describe, expect, it } from 'vitest';
import type { AiApprovalRequest, AiMessage, AiResultCard } from '../../api/types';
import { appendDeltaToMessageParts, mergeRemoteAndLocalMessage } from './aiWorkspaceHelpers';
import { recipeDraft } from './aiWorkspaceTestFixtures';

function approvalRequest(overrides: Partial<AiApprovalRequest> = {}): AiApprovalRequest {
  return {
    id: 'approval-1',
    conversation_id: 'conversation-1',
    message_id: 'message-1',
    run_id: 'run-1',
    draft_id: 'draft-1',
    draft_version: 1,
    draft_schema_version: 'recipe.v1',
    approval_type: 'recipe.create',
    status: 'pending',
    title: '确认创建菜谱',
    instruction: '确认后会创建菜谱。',
    approve_label: '创建菜谱',
    reject_label: '暂不创建',
    require_reject_comment: false,
    field_schema: [{ name: 'recipe', label: '菜谱草稿', type: 'string', widget: 'textarea', required: true }],
    initial_values: { recipe: recipeDraft('原始草稿') },
    submitted_values: {},
    decision: null,
    comment: null,
    resolved_at: null,
    expires_at: null,
    created_at: '2026-05-30T00:00:00Z',
    ...overrides,
  };
}

describe('aiWorkspaceHelpers', () => {
  it('appends reused text part ids after existing non-text parts', () => {
    const parts: AiMessage['parts'] = [
      { id: 'assistant-text', type: 'text', text: '已创建第一份菜谱。' },
      {
        id: 'activity-first-draft',
        type: 'run_activity',
        activity: {
          id: 'draft-first',
          run_id: 'run-reused-text',
          type: 'tool',
          internal_code: 'recipe.create_draft',
          user_message: '生成「菜谱确认表单」',
          status: 'completed',
          created_at: '2026-05-30T00:00:01Z',
        },
      },
    ];

    const nextParts = appendDeltaToMessageParts(parts, '接下来生成第二份菜谱。', 'assistant-text', false, false);

    expect(nextParts).toEqual([
      parts[0],
      parts[1],
      { id: 'continuation-assistant-text', type: 'text', text: '接下来生成第二份菜谱。' },
    ]);

    const laterParts = appendDeltaToMessageParts(
      [
        ...nextParts,
        {
          id: 'activity-second-draft',
          type: 'run_activity',
          activity: {
            id: 'draft-second',
            run_id: 'run-reused-text',
            type: 'tool',
            internal_code: 'recipe.create_draft',
            user_message: '生成「菜谱确认表单」',
            status: 'completed',
            created_at: '2026-05-30T00:00:02Z',
          },
        },
      ],
      '接下来生成第三份菜谱。',
      'assistant-text',
      false,
      false,
    );

    expect(laterParts.at(-1)).toEqual({
      id: 'continuation-assistant-text-2',
      type: 'text',
      text: '接下来生成第三份菜谱。',
    });
  });

  it('keeps approval continuation chunks in one text part after structural parts', () => {
    const parts: AiMessage['parts'] = [
      { id: 'assistant-text', type: 'text', text: '已生成库存处理草稿。' },
      {
        id: 'approval-part-1',
        type: 'approval_request',
        approval: approvalRequest({ status: 'approved', decision: 'approved' }),
      },
      {
        id: 'operation-result',
        type: 'result_card',
        card: {
          id: 'operation-result-card',
          type: 'operation_result',
          title: '已处理库存',
          data: {
            actionSummary: '番茄已录入库存。',
            entityCount: 1,
            entityCountLabel: '1 项库存变更',
            workspaceLabel: '库存页',
          },
        } as AiResultCard,
      },
    ];

    const firstChunkParts = appendDeltaToMessageParts(parts, '已', 'resume-text-after-approval', false, true);
    const nextChunkParts = appendDeltaToMessageParts(firstChunkParts, '确认并处理成功：番茄 2 个已录入库存。', 'resume-text-after-approval', false, true);
    const textParts = nextChunkParts.filter((part) => part.type === 'text');

    expect(textParts).toEqual([
      parts[0],
      {
        id: 'continuation-resume-text-after-approval',
        type: 'text',
        text: '已确认并处理成功：番茄 2 个已录入库存。',
      },
    ]);
  });

  it('does not duplicate final text when final and streamed text ids differ', () => {
    const local: AiMessage = {
      id: 'message-local',
      conversation_id: 'conversation-1',
      role: 'assistant',
      content: '已创建「板栗烧鸡」。\n\n接下来生成「干锅花菜」。',
      content_type: 'parts',
      parts: [
        { id: 'assistant-text', type: 'text', text: '已创建「板栗烧鸡」。' },
        {
          id: 'activity-skill',
          type: 'run_activity',
          activity: {
            id: 'skill-recipe-draft',
            run_id: 'run-final-merge',
            type: 'skill',
            internal_code: 'recipe_draft',
            user_message: '调用「菜谱整理」技能',
            status: 'completed',
            created_at: '2026-05-30T00:00:01Z',
          },
        },
        { id: 'continuation-assistant-text', type: 'text', text: '接下来生成「干锅花菜」。' },
      ],
      run_id: 'run-final-merge',
      status: 'running',
      metadata: {},
      created_at: '2026-05-30T00:00:00Z',
    };
    const remote: AiMessage = {
      ...local,
      id: 'message-remote',
      content: '已创建「板栗烧鸡」。\n\n接下来生成「干锅花菜」。',
      parts: [{ id: 'final-text', type: 'text', text: '已创建「板栗烧鸡」。\n\n接下来生成「干锅花菜」。' }],
      status: 'completed',
    };

    const merged = mergeRemoteAndLocalMessage(remote, local);

    expect(merged.parts.filter((part) => part.type === 'text')).toEqual([
      local.parts[0],
      local.parts[2],
    ]);
    expect(merged.content).toBe('已创建「板栗烧鸡」。\n\n接下来生成「干锅花菜」。');
  });

  it('does not append a final text snapshot when it is missing the streamed first character', () => {
    const local: AiMessage = {
      id: 'message-local',
      conversation_id: 'conversation-1',
      role: 'assistant',
      content: '已确认并处理成功：番茄 2 个已录入库存，存放位置为冷藏。',
      content_type: 'parts',
      parts: [
        { id: 'assistant-text', type: 'text', text: '已确认并处理成功：番茄 2 个已录入库存，存放位置为冷藏。' },
        {
          id: 'operation-result',
          type: 'result_card',
          card: {
            id: 'operation-result-card',
            type: 'operation_result',
            title: '已处理库存',
            data: {
              actionSummary: '番茄已录入库存。',
              entityCount: 1,
              entityCountLabel: '1 项库存变更',
              workspaceLabel: '库存页',
            },
          } as AiResultCard,
        },
      ],
      run_id: 'run-final-merge',
      status: 'completed',
      metadata: {},
      created_at: '2026-05-30T00:00:00Z',
    };
    const remote: AiMessage = {
      ...local,
      id: 'message-remote',
      parts: [{ id: 'final-text', type: 'text', text: '确认并处理成功：番茄 2 个已录入库存，存放位置为冷藏。' }],
    };

    const merged = mergeRemoteAndLocalMessage(remote, local);

    expect(merged.parts.filter((part) => part.type === 'text')).toEqual([local.parts[0]]);
    expect(merged.content).toBe('已确认并处理成功：番茄 2 个已录入库存，存放位置为冷藏。');
  });

  it('keeps completed local stream order when a remote final text snapshot uses another id', () => {
    const local: AiMessage = {
      id: 'message-local',
      conversation_id: 'conversation-1',
      role: 'assistant',
      content: '已创建「板栗烧鸡」。\n\n接下来生成「干锅花菜」。',
      content_type: 'parts',
      parts: [
        { id: 'assistant-text', type: 'text', text: '已创建「板栗烧鸡」。' },
        {
          id: 'activity-skill',
          type: 'run_activity',
          activity: {
            id: 'skill-recipe-draft',
            run_id: 'run-final-merge',
            type: 'skill',
            internal_code: 'recipe_draft',
            user_message: '调用「菜谱整理」技能',
            status: 'completed',
            created_at: '2026-05-30T00:00:01Z',
          },
        },
        { id: 'continuation-assistant-text', type: 'text', text: '接下来生成「干锅花菜」。' },
      ],
      run_id: 'run-final-merge',
      status: 'completed',
      metadata: {},
      created_at: '2026-05-30T00:00:00Z',
    };
    const remote: AiMessage = {
      ...local,
      id: 'message-remote',
      parts: [{ id: 'final-text', type: 'text', text: '已创建「板栗烧鸡」。\n\n接下来生成「干锅花菜」。' }],
    };

    const merged = mergeRemoteAndLocalMessage(remote, local);

    expect(merged.status).toBe('completed');
    expect(merged.parts).toEqual(local.parts);
  });

  it('keeps new final text when it is not the full streamed text snapshot', () => {
    const local: AiMessage = {
      id: 'message-local',
      conversation_id: 'conversation-1',
      role: 'assistant',
      content: '已创建「板栗烧鸡」。',
      content_type: 'parts',
      parts: [
        { id: 'assistant-text', type: 'text', text: '已创建「板栗烧鸡」。' },
        {
          id: 'activity-skill',
          type: 'run_activity',
          activity: {
            id: 'skill-recipe-draft',
            run_id: 'run-final-merge',
            type: 'skill',
            internal_code: 'recipe_draft',
            user_message: '调用「菜谱整理」技能',
            status: 'completed',
            created_at: '2026-05-30T00:00:01Z',
          },
        },
      ],
      run_id: 'run-final-merge',
      status: 'completed',
      metadata: {},
      created_at: '2026-05-30T00:00:00Z',
    };
    const remote: AiMessage = {
      ...local,
      id: 'message-remote',
      content: '已创建「板栗烧鸡」。\n\n可以继续补充口味偏好。',
      parts: [{ id: 'final-text', type: 'text', text: '已创建「板栗烧鸡」。\n\n可以继续补充口味偏好。' }],
    };

    const merged = mergeRemoteAndLocalMessage(remote, local);

    expect(merged.parts.filter((part) => part.type === 'text')).toEqual([
      local.parts[0],
      { id: 'final-text', type: 'text', text: '可以继续补充口味偏好。' },
    ]);
    expect(merged.content).toBe('已创建「板栗烧鸡」。\n\n可以继续补充口味偏好。');
  });
});
