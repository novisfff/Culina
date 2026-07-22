import React, { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../../api/client';
import type { AiChatResponse } from '../../api/types';
import { changeInputValue, cleanupTestDomAndMocks, flushAsync, renderWithQuery } from '../../test/renderWithQuery';
import { AiWorkspace } from './AiWorkspace';
import { conversation, qualityMetrics } from './aiWorkspaceTestFixtures';

afterEach(() => {
  cleanupTestDomAndMocks();
});

beforeEach(() => {
  vi.spyOn(api, 'getAiStatus').mockResolvedValue({
    enabled: true,
    provider: 'openai-compatible',
    model: 'fake-model',
    supports_vision: true,
    status: 'ready',
    detail: 'AI 已就绪。',
  });
  vi.spyOn(api, 'getAiQualityMetrics').mockResolvedValue(qualityMetrics());
  vi.spyOn(api, 'getFoods').mockResolvedValue([]);
  vi.spyOn(api, 'getIngredients').mockResolvedValue([]);
});

describe('AiWorkspace attachments', () => {
  it('hides sent image attachments from the composer while keeping them in the message', async () => {
    const originalCreateObjectURL = Object.getOwnPropertyDescriptor(URL, 'createObjectURL');
    const originalRevokeObjectURL = Object.getOwnPropertyDescriptor(URL, 'revokeObjectURL');
    const createObjectURLSpy = vi.fn(() => 'blob:ai-composer-preview');
    const revokeObjectURLSpy = vi.fn();
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectURLSpy });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revokeObjectURLSpy });

    try {
      vi.spyOn(api, 'getAiMessages').mockResolvedValue([]);
      vi.spyOn(api, 'getPendingAiApprovals').mockResolvedValue([]);
      vi.spyOn(api, 'uploadMedia').mockResolvedValue({
        id: 'media-image-1',
        name: 'fridge.png',
        url: '/media/family-1/fridge.png',
        source: 'upload',
        alt: 'fridge.png',
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
      });
      let resolveStream: ((response: AiChatResponse) => void) | null = null;
      const streamSpy = vi.spyOn(api, 'streamChatAi').mockImplementation(async () => new Promise<AiChatResponse>((resolve) => {
        resolveStream = resolve;
      }));
      const rendered = await renderWithQuery(<AiWorkspace conversations={[conversation()]} isLoading={false} />);
      await flushAsync();

      const desktopView = rendered.container.querySelector('.ai-desktop-view') as HTMLElement;
      const fileInput = desktopView.querySelector<HTMLInputElement>('input[type="file"]') as HTMLInputElement;
      const imageFile = new File(['image'], 'fridge.png', { type: 'image/png' });
      await act(async () => {
        Object.defineProperty(fileInput, 'files', { configurable: true, value: [imageFile] });
        fileInput.dispatchEvent(new Event('change', { bubbles: true }));
      });
      await flushAsync();

      expect(desktopView.querySelector('.ai-composer-attachments')?.textContent).toContain('已添加');
      changeInputValue(desktopView.querySelector<HTMLTextAreaElement>('textarea.text-input') as HTMLTextAreaElement, '看看这张图');
      await act(async () => {
        desktopView.querySelector<HTMLFormElement>('form.ai-composer')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      });
      await flushAsync();

      expect(streamSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          message: '看看这张图',
          attachments: [{ type: 'image', media_id: 'media-image-1', client_attachment_id: expect.any(String) }],
        }),
        expect.any(Object),
      );
      expect(desktopView.querySelector('.ai-composer-attachments')).toBeNull();
      expect(desktopView.querySelector('.ai-message-image-grid img')).not.toBeNull();

      await act(async () => {
        resolveStream?.({
          conversation_id: 'conversation-1',
          message: {
            id: 'message-final',
            conversation_id: 'conversation-1',
            role: 'assistant',
            content: '我看到了这张图片。',
            content_type: 'parts',
            parts: [{ id: 'part-final', type: 'text', text: '我看到了这张图片。' }],
            run_id: 'run-final',
            status: 'completed',
            metadata: {},
            created_at: '2026-05-30T00:00:00Z',
          },
          run: {
            id: 'run-final',
            agent_key: 'general_chat_agent',
            intent: 'general_chat',
            status: 'completed',
            model: 'rules',
            created_at: '2026-05-30T00:00:00Z',
          },
          events: [],
          included: { result_cards: [], drafts: [], approvals: [] },
        });
      });
      await flushAsync();
      expect(revokeObjectURLSpy).toHaveBeenCalledWith('blob:ai-composer-preview');
      rendered.unmount();
    } finally {
      if (originalCreateObjectURL) {
        Object.defineProperty(URL, 'createObjectURL', originalCreateObjectURL);
      } else {
        delete (URL as unknown as Record<string, unknown>).createObjectURL;
      }
      if (originalRevokeObjectURL) {
        Object.defineProperty(URL, 'revokeObjectURL', originalRevokeObjectURL);
      } else {
        delete (URL as unknown as Record<string, unknown>).revokeObjectURL;
      }
    }
  });

  it('hides sent image attachments when the message starts a new conversation', async () => {
    const originalCreateObjectURL = Object.getOwnPropertyDescriptor(URL, 'createObjectURL');
    const originalRevokeObjectURL = Object.getOwnPropertyDescriptor(URL, 'revokeObjectURL');
    const createObjectURLSpy = vi.fn(() => 'blob:ai-new-conversation-preview');
    const revokeObjectURLSpy = vi.fn();
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectURLSpy });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revokeObjectURLSpy });

    try {
      vi.spyOn(api, 'getAiMessages').mockResolvedValue([]);
      vi.spyOn(api, 'getPendingAiApprovals').mockResolvedValue([]);
      vi.spyOn(api, 'uploadMedia').mockResolvedValue({
        id: 'media-image-new',
        name: 'receipt.png',
        url: '/media/family-1/receipt.png',
        source: 'upload',
        alt: 'receipt.png',
        variants: {
          thumb: {
            url: '/media/family-1/variants/media-image-new/thumb.webp',
            width: 240,
            height: 180,
            content_type: 'image/webp',
            byte_size: 1024,
          },
        },
        created_at: '2026-05-30T00:00:00Z',
      });
      const streamSpy = vi.spyOn(api, 'streamChatAi').mockImplementation(async () => new Promise<AiChatResponse>(() => undefined));
      const rendered = await renderWithQuery(<AiWorkspace conversations={[]} isLoading={false} />);
      await flushAsync();

      const desktopView = rendered.container.querySelector('.ai-desktop-view') as HTMLElement;
      const fileInput = desktopView.querySelector<HTMLInputElement>('input[type="file"]') as HTMLInputElement;
      const imageFile = new File(['image'], 'receipt.png', { type: 'image/png' });
      await act(async () => {
        Object.defineProperty(fileInput, 'files', { configurable: true, value: [imageFile] });
        fileInput.dispatchEvent(new Event('change', { bubbles: true }));
      });
      await flushAsync();

      changeInputValue(desktopView.querySelector<HTMLTextAreaElement>('textarea.text-input') as HTMLTextAreaElement, '整理这张小票');
      await act(async () => {
        desktopView.querySelector<HTMLFormElement>('form.ai-composer')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      });
      await flushAsync();

      expect(streamSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          message: '整理这张小票',
          attachments: [{ type: 'image', media_id: 'media-image-new', client_attachment_id: expect.any(String) }],
        }),
        expect.any(Object),
      );
      expect(desktopView.querySelector('.ai-composer-attachments')).toBeNull();
      expect(desktopView.querySelector('.ai-message-image-grid img')).not.toBeNull();
      rendered.unmount();
    } finally {
      if (originalCreateObjectURL) {
        Object.defineProperty(URL, 'createObjectURL', originalCreateObjectURL);
      } else {
        delete (URL as unknown as Record<string, unknown>).createObjectURL;
      }
      if (originalRevokeObjectURL) {
        Object.defineProperty(URL, 'revokeObjectURL', originalRevokeObjectURL);
      } else {
        delete (URL as unknown as Record<string, unknown>).revokeObjectURL;
      }
    }
  });
});
