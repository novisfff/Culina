import React, { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AiMessage, AiMessagePart, AiRunEvent } from '../../api/types';
import { changeInputValue, cleanupTestDomAndMocks, flushAsync, renderWithQuery } from '../../test/renderWithQuery';
import { MessageBubble } from './AiConversationThread';
import { approval, mealPlanApproval, shoppingApproval } from './aiWorkspaceTestFixtures';

afterEach(() => {
  cleanupTestDomAndMocks();
});

const testUser = { id: 'user-1', username: 'me', display_name: '我', avatar_seed: 'seed', avatar_image: null };

function humanInputMessage(overrides: Partial<AiMessagePart> = {}): AiMessage {
  return {
    id: 'message-human-input',
    conversation_id: 'conversation-1',
    role: 'assistant',
    content: '你想怎么处理缺少的青椒？',
    content_type: 'parts',
    parts: [
      {
        id: 'human-input-part',
        type: 'human_input_request',
        status: 'pending',
        request: {
          id: 'human-input-1',
          question: '你想怎么处理缺少的青椒？',
          inputMode: 'choice_or_text',
          options: [{ id: 'restock', label: '先补青椒库存后再做' }],
          allowMultiple: false,
          required: true,
          reason: null,
          sourceSkills: ['recipe_draft'],
          resumeHint: {},
        },
        ...overrides,
      },
    ],
    run_id: 'run-human-input',
    status: 'completed',
    metadata: {},
    created_at: '2026-05-30T00:00:00Z',
  };
}

describe('MessageBubble footer and media rendering', () => {
  it('hides assistant footer actions until the message finishes loading', async () => {
    const rendered = await renderWithQuery(
      <MessageBubble
        message={{
          id: 'message-running',
          conversation_id: 'conversation-1',
          role: 'assistant',
          content: '我正在整理建议。',
          content_type: 'parts',
          parts: [{ id: 'part-running', type: 'text', text: '我正在整理建议。' }],
          run_id: 'run-running',
          status: 'running',
          metadata: {},
          created_at: '2026-05-30T00:00:00Z',
        }}
        user={{ id: 'user-1', username: 'me', display_name: '我', avatar_seed: 'seed', avatar_image: null }}
        onApprovalDecision={() => undefined}
      />,
    );

    expect(rendered.container.querySelector('.ai-message-footer')).toBeNull();
    expect(rendered.container.querySelector('.ai-message-actions-bar')).toBeNull();
    rendered.unmount();
  });

  it('opens run debug from assistant footer when a run id is available', async () => {
    const onOpenRunDebug = vi.fn();
    const rendered = await renderWithQuery(
      <MessageBubble
        message={{
          id: 'message-debug',
          conversation_id: 'conversation-1',
          role: 'assistant',
          content: '已经整理好了。',
          content_type: 'parts',
          parts: [{ id: 'part-debug', type: 'text', text: '已经整理好了。' }],
          run_id: 'run-debug-1',
          status: 'completed',
          metadata: {},
          created_at: '2026-05-30T00:00:00Z',
        }}
        user={{ id: 'user-1', username: 'me', display_name: '我', avatar_seed: 'seed', avatar_image: null }}
        onApprovalDecision={() => undefined}
        onOpenRunDebug={onOpenRunDebug}
      />,
    );

    const button = rendered.container.querySelector<HTMLButtonElement>('[aria-label="查看调试信息"]');
    expect(button).not.toBeNull();
    await act(async () => {
      button?.click();
    });

    expect(onOpenRunDebug).toHaveBeenCalledWith('run-debug-1');
    rendered.unmount();
  });

  it('hides assistant footer actions while waiting for approval', async () => {
    const pendingApproval = approval({ id: 'approval-waiting-footer', status: 'pending' });
    const rendered = await renderWithQuery(
      <MessageBubble
        message={{
          id: 'message-waiting-approval',
          conversation_id: 'conversation-1',
          role: 'assistant',
          content: '请先确认这个计划。',
          content_type: 'parts',
          parts: [
            { id: 'part-text-waiting-approval', type: 'text', text: '请先确认这个计划。' },
            { id: 'part-approval-waiting', type: 'approval_request', approval: pendingApproval },
          ],
          run_id: 'run-waiting-approval',
          status: 'waiting_approval',
          metadata: {},
          created_at: '2026-05-30T00:00:00Z',
        }}
        user={{ id: 'user-1', username: 'me', display_name: '我', avatar_seed: 'seed', avatar_image: null }}
        onApprovalDecision={() => undefined}
      />,
    );

    expect(rendered.container.querySelector('.ai-message-footer')).toBeNull();
    expect(rendered.container.querySelector('.ai-message-actions-bar')).toBeNull();
    rendered.unmount();
  });

  it('hides assistant footer actions while waiting for human input', async () => {
    const rendered = await renderWithQuery(
      <MessageBubble
        message={{
          id: 'message-waiting-human-input-footer',
          conversation_id: 'conversation-1',
          role: 'assistant',
          content: '你想安排几天晚餐？',
          content_type: 'parts',
          parts: [
            { id: 'part-text-waiting-human-input', type: 'text', text: '你想安排几天晚餐？' },
            {
              id: 'part-human-input-waiting',
              type: 'human_input_request',
              status: 'pending',
              request: {
                id: 'human-input-waiting-footer',
                question: '你想安排几天晚餐？',
                inputMode: 'choice_or_text',
                options: [{ id: 'three-days', label: '三天' }],
                allowMultiple: false,
                required: true,
                reason: null,
                sourceSkills: ['meal_plan'],
                resumeHint: {},
              },
            },
          ],
          run_id: 'run-waiting-human-input',
          status: 'waiting_input',
          metadata: {},
          created_at: '2026-05-30T00:00:00Z',
        }}
        user={{ id: 'user-1', username: 'me', display_name: '我', avatar_seed: 'seed', avatar_image: null }}
        isLatestAssistant
        onApprovalDecision={() => undefined}
        onHumanInputResponse={vi.fn().mockResolvedValue(undefined)}
      />,
    );

    expect(rendered.container.querySelector('.ai-message-footer')).toBeNull();
    expect(rendered.container.querySelector('.ai-message-actions-bar')).toBeNull();
    rendered.unmount();
  });

  it('shows assistant footer actions after the message is complete', async () => {
    const rendered = await renderWithQuery(
      <MessageBubble
        message={{
          id: 'message-completed',
          conversation_id: 'conversation-1',
          role: 'assistant',
          content: '建议今晚做番茄鸡蛋面。',
          content_type: 'parts',
          parts: [{ id: 'part-completed', type: 'text', text: '建议今晚做番茄鸡蛋面。' }],
          run_id: 'run-completed',
          status: 'completed',
          metadata: {},
          created_at: '2026-05-30T00:00:00Z',
        }}
        user={{ id: 'user-1', username: 'me', display_name: '我', avatar_seed: 'seed', avatar_image: null }}
        onApprovalDecision={() => undefined}
      />,
    );

    expect(rendered.container.querySelector('.ai-message-footer')).not.toBeNull();
    expect(rendered.container.querySelectorAll('.ai-message-action-btn')).toHaveLength(3);
    rendered.unmount();
  });

  it('hides assistant footer actions while the same run is still streaming', async () => {
    const rendered = await renderWithQuery(
      <MessageBubble
        message={{
          id: 'message-completed-but-active-run',
          conversation_id: 'conversation-1',
          role: 'assistant',
          content: '已创建白切鸡，接下来继续整理第二份菜谱。',
          content_type: 'parts',
          parts: [{ id: 'part-completed-but-active-run', type: 'text', text: '已创建白切鸡，接下来继续整理第二份菜谱。' }],
          run_id: 'run-still-streaming',
          status: 'completed',
          metadata: {},
          created_at: '2026-05-30T00:00:00Z',
        }}
        user={{ id: 'user-1', username: 'me', display_name: '我', avatar_seed: 'seed', avatar_image: null }}
        runEvents={[
          {
            id: 'event-completed-draft',
            run_id: 'run-still-streaming',
            type: 'tool',
            internal_code: 'recipe.create_draft',
            user_message: '生成「菜谱确认表单」',
            status: 'completed',
            created_at: '2026-05-30T00:00:01Z',
          },
        ]}
        isAssistantResponseActive
        onApprovalDecision={() => undefined}
      />,
    );

    expect(rendered.container.querySelector('.ai-message-footer')).toBeNull();
    expect(rendered.container.querySelector('.ai-message-actions-bar')).toBeNull();
    rendered.unmount();
  });

  it('hides assistant footer actions while a run activity is still active', async () => {
    const rendered = await renderWithQuery(
      <MessageBubble
        message={{
          id: 'message-active-run-event',
          conversation_id: 'conversation-1',
          role: 'assistant',
          content: '接下来继续整理第二份菜谱。',
          content_type: 'parts',
          parts: [{ id: 'part-active-run-event', type: 'text', text: '接下来继续整理第二份菜谱。' }],
          run_id: 'run-active-event',
          status: 'completed',
          metadata: {},
          created_at: '2026-05-30T00:00:00Z',
        }}
        user={{ id: 'user-1', username: 'me', display_name: '我', avatar_seed: 'seed', avatar_image: null }}
        runEvents={[
          {
            id: 'event-running-draft',
            run_id: 'run-active-event',
            type: 'tool',
            internal_code: 'recipe.create_draft',
            user_message: '生成「菜谱确认表单」',
            status: 'running',
            created_at: '2026-05-30T00:00:01Z',
          },
        ]}
        onApprovalDecision={() => undefined}
      />,
    );

    expect(rendered.container.querySelector('.ai-message-footer')).toBeNull();
    expect(rendered.container.querySelector('.ai-message-actions-bar')).toBeNull();
    rendered.unmount();
  });

  it('renders image parts in message bubbles', async () => {
    const rendered = await renderWithQuery(
      <MessageBubble
        message={{
          id: 'message-image',
          conversation_id: 'conversation-1',
          role: 'user',
          content: '上传了 1 张图片',
          content_type: 'parts',
          parts: [
            {
              id: 'part-image',
              type: 'image',
              image: {
                media_id: 'media-image-1',
                alt: '冰箱里的蔬菜',
                asset: {
                  id: 'media-image-1',
                  name: 'fridge.jpg',
                  url: '/media/family-1/fridge.jpg',
                  source: 'upload',
                  alt: '冰箱里的蔬菜',
                  variants: {
                    thumb: {
                      url: '/media/family-1/variants/media-image-1/thumb.webp',
                      width: 240,
                      height: 180,
                      content_type: 'image/webp',
                      byte_size: 1024,
                    },
                  },
                  created_at: '2026-05-30T00:00:00Z',
                },
              },
            },
          ],
          run_id: 'run-image',
          status: 'completed',
          metadata: {},
          created_at: '2026-05-30T00:00:00Z',
        }}
        user={{ id: 'user-1', username: 'me', display_name: '我', avatar_seed: 'seed', avatar_image: null }}
        onApprovalDecision={() => undefined}
      />,
    );

    const image = rendered.container.querySelector<HTMLImageElement>('.ai-message-image-grid img');
    expect(image?.alt).toBe('冰箱里的蔬菜');
    expect(image?.src).toContain('/media/family-1/variants/media-image-1/thumb.webp');
    rendered.unmount();
  });
});

describe('MessageBubble human input rendering', () => {
  it('submits a preset human input option directly and collapses with the answer summary', async () => {
    const respond = vi.fn().mockResolvedValue(undefined);
    const rendered = await renderWithQuery(
      <MessageBubble
        message={humanInputMessage()}
        user={testUser}
        isLatestAssistant
        onApprovalDecision={() => undefined}
        onHumanInputResponse={respond}
      />,
    );

    expect(rendered.container.querySelector('.ai-approval-panel.is-expanded')).not.toBeNull();
    await act(async () => {
      rendered.container.querySelector<HTMLButtonElement>('.ai-clarification-option')?.click();
    });
    await flushAsync();

    expect(respond).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'message-human-input' }),
      expect.objectContaining({ id: 'human-input-1' }),
      { selected_option_ids: ['restock'], text: undefined },
    );
    expect(rendered.container.querySelector('.ai-approval-panel.is-human-input-resolved')).not.toBeNull();
    expect(rendered.container.querySelector('.ai-approval-body-wrapper')?.getAttribute('aria-hidden')).toBe('true');
    expect(rendered.container.textContent).toContain('已提交');
    expect(rendered.container.textContent).toContain('回答');
    expect(rendered.container.textContent).toContain('先补青椒库存后再做');

    await act(async () => {
      rendered.container.querySelector<HTMLElement>('.ai-approval-head')?.click();
    });
    expect(rendered.container.querySelector('.ai-approval-panel.is-expanded')).not.toBeNull();
    expect(rendered.container.querySelector('.ai-approval-body-wrapper')?.getAttribute('aria-hidden')).toBe('false');
    rendered.unmount();
  });

  it('marks a human input answer submitted before the response stream resolves', async () => {
    const respond = vi.fn(() => new Promise<void>(() => undefined));
    const rendered = await renderWithQuery(
      <MessageBubble
        message={humanInputMessage({
          id: 'human-input-part-pending-submit',
          request: {
            id: 'human-input-pending-submit',
            question: '你想安排几天晚餐？',
            inputMode: 'choice',
            options: [{ id: 'three-days', label: '三天' }],
            allowMultiple: false,
            required: true,
            reason: null,
            sourceSkills: ['meal_plan'],
            resumeHint: {},
          },
        })}
        user={testUser}
        isLatestAssistant
        onApprovalDecision={() => undefined}
        onHumanInputResponse={respond}
      />,
    );

    await act(async () => {
      rendered.container.querySelector<HTMLButtonElement>('.ai-clarification-option')?.click();
      await Promise.resolve();
    });

    expect(respond).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'message-human-input' }),
      expect.objectContaining({ id: 'human-input-pending-submit' }),
      { selected_option_ids: ['three-days'], text: undefined },
    );
    expect(rendered.container.querySelector('.ai-approval-panel.is-human-input-resolved')).not.toBeNull();
    expect(rendered.container.querySelector('.ai-approval-body-wrapper')?.getAttribute('aria-hidden')).toBe('true');
    expect(rendered.container.textContent).toContain('已提交');
    expect(rendered.container.textContent).toContain('三天');
    rendered.unmount();
  });

  it('renders persisted human input answers after reloading messages', async () => {
    const respond = vi.fn().mockResolvedValue(undefined);
    const rendered = await renderWithQuery(
      <MessageBubble
        message={humanInputMessage({
          status: 'completed',
          responded_at: '2026-05-30T00:01:00Z',
          response: {
            selectedOptionIds: ['three-days'],
            text: '',
            summary: '三天',
          },
        })}
        user={testUser}
        isLatestAssistant
        onApprovalDecision={() => undefined}
        onHumanInputResponse={respond}
      />,
    );

    expect(rendered.container.querySelector('.ai-approval-panel.is-human-input-resolved')).not.toBeNull();
    expect(rendered.container.querySelector('.ai-approval-body-wrapper')?.getAttribute('aria-hidden')).toBe('true');
    expect(rendered.container.textContent).toContain('回答');
    expect(rendered.container.textContent).toContain('三天');
    expect(respond).not.toHaveBeenCalled();
    rendered.unmount();
  });

  it('shows manual input only after choosing the manual option', async () => {
    const respond = vi.fn().mockResolvedValue(undefined);
    const rendered = await renderWithQuery(
      <MessageBubble
        message={humanInputMessage()}
        user={testUser}
        isLatestAssistant
        onApprovalDecision={() => undefined}
        onHumanInputResponse={respond}
      />,
    );

    expect(rendered.container.querySelector('.ai-human-input-manual-panel')).toBeNull();
    const options = rendered.container.querySelectorAll<HTMLButtonElement>('.ai-clarification-option');
    expect(options).toHaveLength(2);
    expect(options[1].textContent).toContain('手动输入');

    await act(async () => {
      options[1].click();
    });
    const textarea = rendered.container.querySelector<HTMLTextAreaElement>('.ai-human-input-manual-panel textarea.text-input') as HTMLTextAreaElement;
    expect(textarea).not.toBeNull();
    changeInputValue(textarea, '先把菜谱改成不需要青椒');
    await act(async () => {
      rendered.container.querySelector<HTMLButtonElement>('.ai-human-input-submit')?.click();
    });
    await flushAsync();

    expect(respond).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'message-human-input' }),
      expect.objectContaining({ id: 'human-input-1' }),
      { selected_option_ids: [], text: '先把菜谱改成不需要青椒' },
    );
    expect(rendered.container.textContent).toContain('先把菜谱改成不需要青椒');
    rendered.unmount();
  });

  it('warns before replacing a drafted manual input with a preset option', async () => {
    const respond = vi.fn().mockResolvedValue(undefined);
    const rendered = await renderWithQuery(
      <MessageBubble
        message={humanInputMessage()}
        user={testUser}
        isLatestAssistant
        onApprovalDecision={() => undefined}
        onHumanInputResponse={respond}
      />,
    );

    const options = rendered.container.querySelectorAll<HTMLButtonElement>('.ai-clarification-option');
    await act(async () => {
      options[1].click();
    });
    const textarea = rendered.container.querySelector<HTMLTextAreaElement>('.ai-human-input-manual-panel textarea.text-input') as HTMLTextAreaElement;
    changeInputValue(textarea, '我想先改菜谱');
    await act(async () => {
      options[0].click();
    });
    await flushAsync();

    expect(respond).not.toHaveBeenCalled();
    expect(rendered.container.textContent).toContain('手动输入还没提交');
    expect(textarea.value).toBe('我想先改菜谱');

    await act(async () => {
      rendered.container.querySelector<HTMLButtonElement>('.ai-human-input-switch-warning .solid-button')?.click();
    });
    await flushAsync();

    expect(respond).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'message-human-input' }),
      expect.objectContaining({ id: 'human-input-1' }),
      { selected_option_ids: ['restock'], text: undefined },
    );
    expect(rendered.container.textContent).toContain('先补青椒库存后再做');
    rendered.unmount();
  });
});

describe('MessageBubble run activity rendering', () => {
  it('keeps streamed content append-only when activity arrives between text parts', async () => {
    const updateApproval = approval({
      id: 'approval-ingredient-update',
      title: '确认更新食材档案',
      instruction: '确认后会更新当前家庭的食材档案。',
      approval_type: 'ingredient_profile.update',
      draft_schema_version: 'ingredient_profile.v1',
      field_schema: [{ name: 'draft', label: '草稿内容', type: 'object', widget: 'textarea', required: true }],
      initial_values: {
        draft: {
          draftType: 'ingredient_profile',
          schemaVersion: 'ingredient_profile.v1',
          name: '秋葵自动测0622010623',
          defaultUnit: '根',
          storage: '常温',
        },
      },
      submitted_values: {},
    });
    const renderMessage = (parts: Parameters<typeof MessageBubble>[0]['message']['parts'], runEvents = [] as Parameters<typeof MessageBubble>[0]['runEvents']) => (
      <MessageBubble
        message={{
          id: 'message-append-only',
          conversation_id: 'conversation-1',
          role: 'assistant',
          content: parts.filter((part) => part.type === 'text').map((part) => part.text).filter(Boolean).join('\n\n'),
          content_type: 'parts',
          parts,
          run_id: 'run-append-only',
          status: 'completed',
          metadata: {},
          created_at: '2026-05-30T00:00:00Z',
        }}
        user={testUser}
        runEvents={runEvents}
        isLatestAssistant
        onApprovalDecision={() => undefined}
        onHumanInputResponse={vi.fn().mockResolvedValue(undefined)}
      />
    );
    const parts = {
      firstText: { id: 'text-before-tool', type: 'text' as const, text: '我先看一下当前食材。' },
      secondText: { id: 'text-after-tool', type: 'text' as const, text: '已经查到同名食材，继续生成确认草稿。' },
      approval: { id: 'approval-part', type: 'approval_request' as const, approval: updateApproval },
    };
    const events = {
      lookup: {
        id: 'progress-lookup',
        run_id: 'run-append-only',
        type: 'tool',
        internal_code: 'ingredient_profile.lookup',
        user_message: '调用「食材资料」',
        status: 'completed',
        created_at: '2026-05-30T00:00:01Z',
      } as const,
      draft: {
        id: 'progress-draft',
        run_id: 'run-append-only',
        type: 'tool',
        internal_code: 'ingredient_profile.create_draft',
        user_message: '生成「食材档案确认表单」',
        status: 'completed',
        created_at: '2026-05-30T00:00:02Z',
      } as const,
    };
    const rendered = await renderWithQuery(
      renderMessage([parts.firstText]),
    );

    await flushAsync();
    await rendered.rerender(renderMessage([parts.firstText, { id: 'activity-lookup', type: 'run_activity', activity: events.lookup }]));
    await flushAsync();
    await rendered.rerender(renderMessage([parts.firstText, { id: 'activity-lookup', type: 'run_activity', activity: events.lookup }, parts.secondText]));
    await flushAsync();
    await rendered.rerender(renderMessage([
      parts.firstText,
      { id: 'activity-lookup', type: 'run_activity', activity: events.lookup },
      parts.secondText,
      { id: 'activity-draft', type: 'run_activity', activity: events.draft },
      parts.approval,
    ]));
    await flushAsync();
    const messageBody = rendered.container.querySelector('.ai-message-body') as HTMLElement;
    const textBlocks = Array.from(messageBody.querySelectorAll<HTMLElement>('.ai-message-text-block'));
    const activities = Array.from(messageBody.querySelectorAll<HTMLElement>('.ai-run-activity'));
    const approvalTitle = Array.from(messageBody.querySelectorAll('h3')).find((title) => title.textContent === '确认更新食材档案') as HTMLElement;
    const approvalPanel = approvalTitle.closest('.ai-approval-panel') as HTMLElement;
    expect(textBlocks).toHaveLength(2);
    expect(activities).toHaveLength(2);
    expect(textBlocks[0]?.textContent).toContain('我先看一下当前食材。');
    expect(activities[0]?.textContent).toContain('调用「食材资料」');
    expect(textBlocks[1]?.textContent).toContain('已经查到同名食材');
    expect(activities[1]?.textContent).toContain('生成「食材档案确认表单」');
    expect(textBlocks[0]?.compareDocumentPosition(activities[0] as HTMLElement) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(activities[0]?.compareDocumentPosition(textBlocks[1] as HTMLElement) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(textBlocks[1]?.compareDocumentPosition(activities[1] as HTMLElement) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(activities[1]?.compareDocumentPosition(approvalPanel) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    rendered.unmount();
  });

  it('deduplicates script and tool activity status updates', async () => {
    const scriptRunning = {
      id: 'script-running',
      run_id: 'run-dedup',
      type: 'script',
      internal_code: 'script.lint_recipe_draft',
      user_message: '调用脚本「lint_recipe_draft」',
      status: 'running',
      created_at: '2026-05-30T00:00:01Z',
    } as const;
    const scriptCompleted = {
      ...scriptRunning,
      user_message: '脚本「lint_recipe_draft」执行完成',
      status: 'completed',
      created_at: '2026-05-30T00:00:02Z',
    } as const;
    const toolRunning = {
      id: 'tool-running',
      run_id: 'run-dedup',
      type: 'tool',
      internal_code: 'inventory.read_available_items',
      user_message: '调用「可用库存」',
      status: 'running',
      created_at: '2026-05-30T00:00:03Z',
    } as const;
    const toolCompleted = {
      ...toolRunning,
      user_message: '调用「可用库存」执行完成',
      status: 'completed',
      created_at: '2026-05-30T00:00:04Z',
    } as const;
    const renderMessage = (parts: Parameters<typeof MessageBubble>[0]['message']['parts'], runEvents = [] as Parameters<typeof MessageBubble>[0]['runEvents']) => (
      <MessageBubble
        message={{
          id: 'message-dedup',
          conversation_id: 'conversation-1',
          role: 'assistant',
          content: '我会先检查菜谱草稿。',
          content_type: 'parts',
          parts,
          run_id: 'run-dedup',
          status: 'completed',
          metadata: {},
          created_at: '2026-05-30T00:00:00Z',
        }}
        user={testUser}
        runEvents={runEvents}
        onApprovalDecision={() => undefined}
      />
    );
    const rendered = await renderWithQuery(
      renderMessage([
        { id: 'script-running-part', type: 'run_activity', activity: scriptRunning },
        { id: 'script-completed-part', type: 'run_activity', activity: scriptCompleted },
        { id: 'tool-running-part', type: 'run_activity', activity: toolRunning },
        { id: 'tool-completed-part', type: 'run_activity', activity: toolCompleted },
      ]),
    );
    await flushAsync();
    let activityRows = Array.from(rendered.container.querySelectorAll<HTMLElement>('.ai-run-activity-summary .ai-run-activity-row'));
    expect(activityRows.map((row) => row.textContent)).toEqual(['调用脚本「lint_recipe_draft」', '调用「可用库存」']);
    expect(rendered.container.textContent).not.toContain('执行完成');

    await rendered.rerender(renderMessage(
      [{ id: 'dedup-text', type: 'text', text: '我会先检查菜谱草稿。' }],
      [scriptRunning, scriptCompleted, toolRunning, toolCompleted],
    ));
    await flushAsync();
    activityRows = Array.from(rendered.container.querySelectorAll<HTMLElement>('.ai-run-activity-summary .ai-run-activity-row'));
    expect(activityRows.map((row) => row.textContent)).toEqual(['调用脚本「lint_recipe_draft」', '调用「可用库存」']);
    expect(rendered.container.textContent).not.toContain('执行完成');
    rendered.unmount();
  });

  it('keeps repeated non-draft tool calls visible when they are different events', async () => {
    const firstLookup = {
      id: 'food-lookup-first',
      run_id: 'run-repeated-food-lookup',
      type: 'tool',
      internal_code: 'food.search',
      user_message: '调用「食物资料」',
      status: 'completed',
      created_at: '2026-05-30T00:00:01Z',
    } as const;
    const secondLookup = {
      ...firstLookup,
      id: 'food-lookup-second',
      created_at: '2026-05-30T00:00:02Z',
    } as const;
    const thirdLookup = {
      ...firstLookup,
      id: 'food-lookup-third',
      created_at: '2026-05-30T00:00:03Z',
    } as const;
    const rendered = await renderWithQuery(
      <MessageBubble
        message={{
          id: 'message-repeated-food-lookup',
          conversation_id: 'conversation-1',
          role: 'assistant',
          content: '',
          content_type: 'parts',
          parts: [
            { id: 'activity-food-lookup-first', type: 'run_activity', activity: firstLookup },
            { id: 'activity-food-lookup-second', type: 'run_activity', activity: secondLookup },
            { id: 'activity-food-lookup-third', type: 'run_activity', activity: thirdLookup },
          ],
          run_id: 'run-repeated-food-lookup',
          status: 'completed',
          metadata: {},
          created_at: '2026-05-30T00:00:00Z',
        }}
        user={testUser}
        onApprovalDecision={() => undefined}
      />,
    );
    await flushAsync();
    const activityRows = Array.from(rendered.container.querySelectorAll<HTMLElement>('.ai-run-activity-summary .ai-run-activity-row'));
    expect(activityRows.map((row) => row.textContent)).toEqual(['调用「食物资料」', '调用「食物资料」', '调用「食物资料」']);
    rendered.unmount();
  });

  it('marks running tool activity rows as active for the execution animation', async () => {
    const toolRunning: AiRunEvent = {
      id: 'tool-running-active',
      run_id: 'run-active-tool',
      type: 'tool',
      internal_code: 'recipe.create_draft',
      user_message: '生成「菜谱确认表单」',
      status: 'running',
      created_at: '2026-05-30T00:00:03Z',
    };
    const renderMessage = (activity = toolRunning) => (
      <MessageBubble
        message={{
          id: 'message-active-tool',
          conversation_id: 'conversation-1',
          role: 'assistant',
          content: '',
          content_type: 'parts',
          parts: [{ id: 'tool-running-active-part', type: 'run_activity', activity }],
          run_id: 'run-active-tool',
          status: activity.status === 'running' ? 'running' : 'completed',
          metadata: {},
          created_at: '2026-05-30T00:00:00Z',
        }}
        user={testUser}
        runEvents={[]}
        onApprovalDecision={() => undefined}
      />
    );
    const rendered = await renderWithQuery(renderMessage());
    await flushAsync();
    let row = rendered.container.querySelector<HTMLElement>('.ai-run-activity-row');
    expect(row?.className).toContain('is-active');
    expect(row?.className).toContain('kind-draft');

    await rendered.rerender(renderMessage({ ...toolRunning, status: 'completed', created_at: '2026-05-30T00:00:04Z' }));
    await flushAsync();
    row = rendered.container.querySelector<HTMLElement>('.ai-run-activity-row');
    expect(row?.className).not.toContain('is-active');
    rendered.unmount();
  });

  it('keeps repeated draft tool calls visible when they are different events', async () => {
    const firstDraft = {
      id: 'draft-tool-first',
      run_id: 'run-repeated-draft',
      type: 'tool',
      internal_code: 'recipe.create_draft',
      user_message: '生成「菜谱确认表单」',
      status: 'completed',
      created_at: '2026-05-30T00:00:01Z',
    } as const;
    const secondDraft = {
      ...firstDraft,
      id: 'draft-tool-second',
      created_at: '2026-05-30T00:01:01Z',
    } as const;
    const rendered = await renderWithQuery(
      <MessageBubble
        message={{
          id: 'message-repeated-draft',
          conversation_id: 'conversation-1',
          role: 'assistant',
          content: '',
          content_type: 'parts',
          parts: [
            { id: 'activity-first-draft', type: 'run_activity', activity: firstDraft },
            { id: 'activity-second-draft', type: 'run_activity', activity: secondDraft },
          ],
          run_id: 'run-repeated-draft',
          status: 'waiting_approval',
          metadata: {},
          created_at: '2026-05-30T00:00:00Z',
        }}
        user={testUser}
        onApprovalDecision={() => undefined}
      />,
    );
    await flushAsync();
    const activityRows = Array.from(rendered.container.querySelectorAll<HTMLElement>('.ai-run-activity-summary .ai-run-activity-row'));
    expect(activityRows.map((row) => row.textContent)).toEqual(['生成「菜谱确认表单」', '生成「菜谱确认表单」']);
    rendered.unmount();
  });
});

describe('MessageBubble approval gating', () => {
  it('enables the first streamed approval immediately without a generic waiting hint', async () => {
    const firstApproval = mealPlanApproval();
    const secondApproval = shoppingApproval({ id: 'approval-shopping', draft_id: 'draft-shopping' });
    const rendered = await renderWithQuery(
      <MessageBubble
        message={{
          id: 'message-running-approvals',
          conversation_id: 'conversation-1',
          role: 'assistant',
          content: '',
          content_type: 'parts',
          parts: [
            { id: 'approval-part-meal', type: 'approval_request', approval: firstApproval },
            { id: 'approval-part-shopping', type: 'approval_request', approval: secondApproval },
          ],
          run_id: 'run-running-approvals',
          status: 'running',
          metadata: {},
          created_at: '2026-05-30T00:00:00Z',
        }}
        user={testUser}
        isLatestAssistant
        onApprovalDecision={vi.fn()}
      />,
    );
    await flushAsync();
    expect(rendered.container.textContent).toContain('确认创建餐食计划');
    expect(rendered.container.textContent).toContain('确认创建购物清单');
    expect(rendered.container.textContent).toContain('确认入口正在准备，稍后即可确认。');
    expect(rendered.container.textContent).not.toContain('AI 还在整理后续草稿');
    expect(rendered.container.textContent).not.toContain('这个草稿还不能确认，请稍后再试。');
    expect(rendered.container.textContent).toContain('请先处理上一个草稿，再确认这一项。');
    expect(rendered.container.querySelectorAll('.ai-approval-actions .solid-button')).toHaveLength(0);
    rendered.unmount();
  });

  it('only enables the first pending approval when the assistant is waiting for approval', async () => {
    const firstApproval = mealPlanApproval();
    const secondApproval = shoppingApproval({ id: 'approval-shopping', draft_id: 'draft-shopping' });
    const decideSpy = vi.fn().mockResolvedValue(undefined);
    const rendered = await renderWithQuery(
      <MessageBubble
        message={{
          id: 'message-waiting-approvals',
          conversation_id: 'conversation-1',
          role: 'assistant',
          content: '',
          content_type: 'parts',
          parts: [
            { id: 'approval-part-meal', type: 'approval_request', approval: firstApproval },
            { id: 'approval-part-shopping', type: 'approval_request', approval: secondApproval },
          ],
          run_id: 'run-waiting-approvals',
          status: 'waiting_approval',
          metadata: {},
          created_at: '2026-05-30T00:00:00Z',
        }}
        user={testUser}
        isLatestAssistant
        onApprovalDecision={decideSpy}
      />,
    );
    await flushAsync();
    expect(rendered.container.textContent).toContain('请先处理上一个草稿，再确认这一项。');
    const submitButtons = rendered.container.querySelectorAll<HTMLButtonElement>('.ai-approval-actions .solid-button');
    expect(submitButtons).toHaveLength(1);
    await act(async () => {
      submitButtons[0]?.click();
    });
    await flushAsync();
    expect(decideSpy).toHaveBeenCalledTimes(1);
    expect(decideSpy.mock.calls[0]?.[0].id).toBe(firstApproval.id);
    rendered.unmount();
  });

  it('keeps approval actions locked while the same run is still the active stream', async () => {
    const pending = approval({ run_id: 'run-waiting-approval' });
    const message: AiMessage = {
      id: 'message-waiting-approval',
      conversation_id: 'conversation-1',
      role: 'assistant',
      content: '',
      content_type: 'parts',
      parts: [{ id: 'approval-part', type: 'approval_request', approval: pending }],
      run_id: 'run-waiting-approval',
      status: 'waiting_approval',
      metadata: {},
      created_at: '2026-05-30T00:00:00Z',
    };
    const decideSpy = vi.fn().mockResolvedValue(undefined);
    const rendered = await renderWithQuery(
      <MessageBubble
        message={message}
        user={testUser}
        isLatestAssistant
        activeStreamRunId="run-waiting-approval"
        onApprovalDecision={decideSpy}
      />,
    );
    await flushAsync();

    expect(rendered.container.textContent).toContain('确认入口正在准备，稍后即可确认。');
    expect(rendered.container.querySelector('.ai-approval-actions .solid-button')).toBeNull();

    await rendered.rerender(
      <MessageBubble
        message={message}
        user={testUser}
        isLatestAssistant
        activeStreamRunId={null}
        onApprovalDecision={decideSpy}
      />,
    );
    await flushAsync();

    expect(rendered.container.textContent).not.toContain('确认入口正在准备，稍后即可确认。');
    await act(async () => {
      rendered.container.querySelector<HTMLButtonElement>('.ai-approval-actions .solid-button')?.click();
    });
    await flushAsync();
    expect(decideSpy).toHaveBeenCalledTimes(1);
    rendered.unmount();
  });

  it('keeps the current approval in submitting state while its resume stream is active', async () => {
    const pending = approval({ run_id: 'run-waiting-approval' });
    const decideSpy = vi.fn(() => new Promise<void>(() => undefined));
    const rendered = await renderWithQuery(
      <MessageBubble
        message={{
          id: 'message-waiting-approval',
          conversation_id: 'conversation-1',
          role: 'assistant',
          content: '',
          content_type: 'parts',
          parts: [{ id: 'approval-part', type: 'approval_request', approval: pending }],
          run_id: 'run-waiting-approval',
          status: 'waiting_approval',
          metadata: {},
          created_at: '2026-05-30T00:00:00Z',
        }}
        user={testUser}
        isLatestAssistant
        activeStreamRunId="run-waiting-approval"
        submittingApprovalId="approval-1"
        onApprovalDecision={decideSpy}
      />,
    );
    await flushAsync();

    expect(rendered.container.textContent).not.toContain('确认入口正在准备，稍后即可确认。');
    await act(async () => {
      rendered.container.querySelector<HTMLButtonElement>('.ai-approval-actions .solid-button')?.click();
      await Promise.resolve();
    });
    await flushAsync();

    expect(rendered.container.textContent).toContain('提交中...');
    expect(rendered.container.textContent).not.toContain('确认入口正在准备，稍后即可确认。');
    expect(decideSpy).toHaveBeenCalledTimes(1);
    rendered.unmount();
  });
});

describe('MessageBubble error recovery rendering', () => {
  it('renders upgrade error_recovery parts as non-editable guidance', async () => {
    const rendered = await renderWithQuery(
      <MessageBubble
        message={{
          id: 'message-upgrade',
          conversation_id: 'conversation-1',
          role: 'assistant',
          content: '',
          content_type: 'parts',
          parts: [{
            id: 'upgrade-part',
            type: 'error_recovery',
            status: 'blocked',
            text: '当前应用版本不支持新的做菜确认，请刷新并更新后继续。原草稿仍会安全保留。',
          }],
          run_id: 'run-upgrade',
          status: 'completed',
          metadata: {},
          created_at: '2026-05-30T00:00:00Z',
        }}
        user={testUser}
        isLatestAssistant
        onApprovalDecision={() => undefined}
      />,
    );
    await flushAsync();

    expect(rendered.container.textContent).toContain('需要更新后继续');
    expect(rendered.container.textContent).toContain('当前应用版本不支持新的做菜确认');
    expect(rendered.container.querySelector('.ai-approval-actions')).toBeNull();
    rendered.unmount();
  });
});
