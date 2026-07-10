import React, { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../../api/client';
import { cleanupTestDomAndMocks, flushAsync, renderWithQuery } from '../../test/renderWithQuery';
import { useAiAttachmentState, type AiComposerAttachment } from './useAiAttachmentState';

afterEach(() => {
  cleanupTestDomAndMocks();
});

describe('useAiAttachmentState', () => {
  let createObjectURLSpy: ReturnType<typeof vi.fn>;
  let revokeObjectURLSpy: ReturnType<typeof vi.fn>;
  let originalCreateObjectURL: PropertyDescriptor | undefined;
  let originalRevokeObjectURL: PropertyDescriptor | undefined;
  let previewCounter = 0;

  beforeEach(() => {
    previewCounter = 0;
    originalCreateObjectURL = Object.getOwnPropertyDescriptor(URL, 'createObjectURL');
    originalRevokeObjectURL = Object.getOwnPropertyDescriptor(URL, 'revokeObjectURL');
    createObjectURLSpy = vi.fn(() => {
      previewCounter += 1;
      return `blob:ai-preview-${previewCounter}`;
    });
    revokeObjectURLSpy = vi.fn();
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectURLSpy });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revokeObjectURLSpy });
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
  });

  afterEach(() => {
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
  });

  it('keeps attachments isolated and remaps only the requested conversation', async () => {
    let state: ReturnType<typeof useAiAttachmentState> | null = null;
    let scopeKey = 'conversation-a';

    function Harness({ scope }: { scope: string }) {
      state = useAiAttachmentState(scope);
      return (
        <div>
          <span data-testid="count">{state.attachments.length}</span>
          <span data-testid="names">{state.attachments.map((item) => item.fileName).join(',')}</span>
          <span data-testid="ready">{state.readyAttachments.map((item) => item.asset?.id).join(',')}</span>
          <span data-testid="previews">{state.attachments.map((item) => item.previewUrl).join(',')}</span>
        </div>
      );
    }

    const rendered = await renderWithQuery(<Harness scope={scopeKey} />);
    const imageFile = new File(['image'], 'fridge-a.png', { type: 'image/png' });

    await act(async () => {
      state?.uploadFiles([imageFile]);
    });
    await flushAsync();

    expect(rendered.container.querySelector('[data-testid="count"]')?.textContent).toBe('1');
    expect(rendered.container.querySelector('[data-testid="names"]')?.textContent).toBe('fridge-a.png');
    expect(rendered.container.querySelector('[data-testid="ready"]')?.textContent).toBe('media-image-1');
    expect(rendered.container.querySelector('[data-testid="previews"]')?.textContent).toBe('blob:ai-preview-1');

    scopeKey = 'conversation-b';
    await rendered.rerender(<Harness scope={scopeKey} />);
    expect(rendered.container.querySelector('[data-testid="count"]')?.textContent).toBe('0');
    expect(rendered.container.querySelector('[data-testid="ready"]')?.textContent).toBe('');

    act(() => {
      state?.moveScope('conversation-a', 'conversation-server-a');
    });
    scopeKey = 'conversation-server-a';
    await rendered.rerender(<Harness scope={scopeKey} />);

    expect(rendered.container.querySelector('[data-testid="count"]')?.textContent).toBe('1');
    expect(rendered.container.querySelector('[data-testid="names"]')?.textContent).toBe('fridge-a.png');
    expect(rendered.container.querySelector('[data-testid="ready"]')?.textContent).toBe('media-image-1');
    expect(rendered.container.querySelector('[data-testid="previews"]')?.textContent).toBe('blob:ai-preview-1');
    expect(revokeObjectURLSpy).not.toHaveBeenCalled();

    scopeKey = 'conversation-a';
    await rendered.rerender(<Harness scope={scopeKey} />);
    expect(rendered.container.querySelector('[data-testid="count"]')?.textContent).toBe('0');

    rendered.unmount();
  });

  it('revokes superseded blob URLs exactly once when moving onto an occupied scope', async () => {
    let state: ReturnType<typeof useAiAttachmentState> | null = null;
    let scopeKey = 'conversation-a';

    function Harness({ scope }: { scope: string }) {
      state = useAiAttachmentState(scope);
      return <span data-testid="previews">{state.attachments.map((item) => item.previewUrl).join(',')}</span>;
    }

    const rendered = await renderWithQuery(<Harness scope={scopeKey} />);

    await act(async () => {
      state?.uploadFiles([new File(['a'], 'a.png', { type: 'image/png' })]);
    });
    await flushAsync();

    scopeKey = 'conversation-b';
    await rendered.rerender(<Harness scope={scopeKey} />);
    await act(async () => {
      state?.uploadFiles([new File(['b'], 'b.png', { type: 'image/png' })]);
    });
    await flushAsync();

    act(() => {
      state?.moveScope('conversation-a', 'conversation-b');
    });
    await rendered.rerender(<Harness scope={scopeKey} />);

    expect(rendered.container.querySelector('[data-testid="previews"]')?.textContent).toBe('blob:ai-preview-1');
    expect(revokeObjectURLSpy).toHaveBeenCalledTimes(1);
    expect(revokeObjectURLSpy).toHaveBeenCalledWith('blob:ai-preview-2');

    rendered.unmount();
  });

  it('hides restores and discards attachments only for the active scope', async () => {
    let state: ReturnType<typeof useAiAttachmentState> | null = null;
    let hiddenSnapshot: AiComposerAttachment[] = [];

    function Harness({ scope }: { scope: string }) {
      state = useAiAttachmentState(scope);
      return <span data-testid="count">{state.attachments.length}</span>;
    }

    const rendered = await renderWithQuery(<Harness scope="conversation-a" />);
    await act(async () => {
      state?.uploadFiles([new File(['a'], 'a.png', { type: 'image/png' })]);
    });
    await flushAsync();

    const ready = state?.readyAttachments ?? [];
    expect(ready).toHaveLength(1);
    hiddenSnapshot = ready;

    act(() => {
      state?.hideAttachments(ready.map((item) => item.clientAttachmentId));
    });
    expect(rendered.container.querySelector('[data-testid="count"]')?.textContent).toBe('0');

    act(() => {
      state?.restoreHiddenAttachments(hiddenSnapshot);
    });
    expect(rendered.container.querySelector('[data-testid="count"]')?.textContent).toBe('1');

    act(() => {
      state?.hideAttachments(hiddenSnapshot.map((item) => item.clientAttachmentId));
      state?.discardHiddenAttachments(hiddenSnapshot);
    });
    expect(rendered.container.querySelector('[data-testid="count"]')?.textContent).toBe('0');
    expect(revokeObjectURLSpy).toHaveBeenCalledWith('blob:ai-preview-1');

    rendered.unmount();
  });
});
