import React, { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../../api/client';
import { cleanupTestDomAndMocks, flushAsync, renderWithQuery } from '../../test/renderWithQuery';
import { useAiAttachmentState, type AiComposerAttachment } from './useAiAttachmentState';

type AiAttachmentState = ReturnType<typeof useAiAttachmentState>;

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
    const stateBox: { current: AiAttachmentState | null } = { current: null };
    let scopeKey = 'conversation-a';

    function Harness({ scope }: { scope: string }) {
      stateBox.current = useAiAttachmentState(scope);
      return (
        <div>
          <span data-testid="count">{stateBox.current.attachments.length}</span>
          <span data-testid="names">{stateBox.current.attachments.map((item) => item.fileName).join(',')}</span>
          <span data-testid="ready">{stateBox.current.readyAttachments.map((item) => item.asset?.id).join(',')}</span>
          <span data-testid="previews">{stateBox.current.attachments.map((item) => item.previewUrl).join(',')}</span>
        </div>
      );
    }

    const rendered = await renderWithQuery(<Harness scope={scopeKey} />);
    const imageFile = new File(['image'], 'fridge-a.png', { type: 'image/png' });

    await act(async () => {
      stateBox.current?.uploadFiles([imageFile]);
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
      stateBox.current?.moveScope('conversation-a', 'conversation-server-a');
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
    const stateBox: { current: AiAttachmentState | null } = { current: null };
    let scopeKey = 'conversation-a';

    function Harness({ scope }: { scope: string }) {
      stateBox.current = useAiAttachmentState(scope);
      return <span data-testid="previews">{stateBox.current.attachments.map((item) => item.previewUrl).join(',')}</span>;
    }

    const rendered = await renderWithQuery(<Harness scope={scopeKey} />);

    await act(async () => {
      stateBox.current?.uploadFiles([new File(['a'], 'a.png', { type: 'image/png' })]);
    });
    await flushAsync();

    scopeKey = 'conversation-b';
    await rendered.rerender(<Harness scope={scopeKey} />);
    await act(async () => {
      stateBox.current?.uploadFiles([new File(['b'], 'b.png', { type: 'image/png' })]);
    });
    await flushAsync();

    act(() => {
      stateBox.current?.moveScope('conversation-a', 'conversation-b');
    });
    await rendered.rerender(<Harness scope={scopeKey} />);

    expect(rendered.container.querySelector('[data-testid="previews"]')?.textContent).toBe('blob:ai-preview-1');
    expect(revokeObjectURLSpy).toHaveBeenCalledTimes(1);
    expect(revokeObjectURLSpy).toHaveBeenCalledWith('blob:ai-preview-2');

    rendered.unmount();
  });

  it('hides restores and discards attachments only for the active scope', async () => {
    const stateBox: { current: AiAttachmentState | null } = { current: null };
    let hiddenSnapshot: AiComposerAttachment[] = [];

    function Harness({ scope }: { scope: string }) {
      stateBox.current = useAiAttachmentState(scope);
      return <span data-testid="count">{stateBox.current.attachments.length}</span>;
    }

    const rendered = await renderWithQuery(<Harness scope="conversation-a" />);
    await act(async () => {
      stateBox.current?.uploadFiles([new File(['a'], 'a.png', { type: 'image/png' })]);
    });
    await flushAsync();

    const ready: AiComposerAttachment[] = stateBox.current?.readyAttachments ?? [];
    expect(ready).toHaveLength(1);
    hiddenSnapshot = ready;

    act(() => {
      stateBox.current?.hideAttachments(ready.map((item) => item.clientAttachmentId));
    });
    expect(rendered.container.querySelector('[data-testid="count"]')?.textContent).toBe('0');

    act(() => {
      stateBox.current?.restoreHiddenAttachments(hiddenSnapshot);
    });
    expect(rendered.container.querySelector('[data-testid="count"]')?.textContent).toBe('1');

    act(() => {
      stateBox.current?.hideAttachments(hiddenSnapshot.map((item) => item.clientAttachmentId));
      stateBox.current?.discardHiddenAttachments(hiddenSnapshot);
    });
    expect(rendered.container.querySelector('[data-testid="count"]')?.textContent).toBe('0');
    expect(revokeObjectURLSpy).toHaveBeenCalledWith('blob:ai-preview-1');

    rendered.unmount();
  });


  it('keeps hidden attachments intact across a double pending→server moveScope', async () => {
    const stateBox: { current: AiAttachmentState | null } = { current: null };
    let hiddenSnapshot: AiComposerAttachment[] = [];
    let scopeKey = 'pending-conversation-a';

    function Harness({ scope }: { scope: string }) {
      stateBox.current = useAiAttachmentState(scope);
      return (
        <div>
          <span data-testid="count">{stateBox.current.attachments.length}</span>
          <span data-testid="previews">{stateBox.current.attachments.map((item) => item.previewUrl).join(',')}</span>
        </div>
      );
    }

    const rendered = await renderWithQuery(<Harness scope={scopeKey} />);
    await act(async () => {
      stateBox.current?.uploadFiles([new File(['a'], 'hidden.png', { type: 'image/png' })]);
    });
    await flushAsync();

    hiddenSnapshot = [...(stateBox.current?.readyAttachments ?? [])];
    expect(hiddenSnapshot).toHaveLength(1);
    const previewUrl = hiddenSnapshot[0]?.previewUrl;
    expect(previewUrl).toBe('blob:ai-preview-1');

    act(() => {
      stateBox.current?.hideAttachments(hiddenSnapshot.map((item) => item.clientAttachmentId));
    });
    expect(rendered.container.querySelector('[data-testid="count"]')?.textContent).toBe('0');

    act(() => {
      stateBox.current?.moveScope('pending-conversation-a', 'conversation-server-a');
    });
    // Second move: from is already gone (migration + applyChatResponse race). Must not revoke `to`.
    act(() => {
      stateBox.current?.moveScope('pending-conversation-a', 'conversation-server-a');
    });

    expect(revokeObjectURLSpy).not.toHaveBeenCalled();

    scopeKey = 'conversation-server-a';
    await rendered.rerender(<Harness scope={scopeKey} />);
    expect(rendered.container.querySelector('[data-testid="count"]')?.textContent).toBe('0');

    act(() => {
      stateBox.current?.restoreHiddenAttachments(hiddenSnapshot, 'conversation-server-a');
    });
    expect(rendered.container.querySelector('[data-testid="count"]')?.textContent).toBe('1');
    expect(rendered.container.querySelector('[data-testid="previews"]')?.textContent).toBe(previewUrl);
    expect(revokeObjectURLSpy).not.toHaveBeenCalled();

    act(() => {
      stateBox.current?.hideAttachments(hiddenSnapshot.map((item) => item.clientAttachmentId));
      stateBox.current?.discardHiddenAttachments(hiddenSnapshot, 'conversation-server-a');
    });
    expect(rendered.container.querySelector('[data-testid="count"]')?.textContent).toBe('0');
    expect(revokeObjectURLSpy).toHaveBeenCalledTimes(1);
    expect(revokeObjectURLSpy).toHaveBeenCalledWith(previewUrl);

    rendered.unmount();
  });

  it('discards and restores using the captured send scope after switching conversations', async () => {
    const stateBox: { current: AiAttachmentState | null } = { current: null };
    let hiddenSnapshot: AiComposerAttachment[] = [];
    let scopeKey = 'conversation-send';

    function Harness({ scope }: { scope: string }) {
      stateBox.current = useAiAttachmentState(scope);
      return <span data-testid="count">{stateBox.current.attachments.length}</span>;
    }

    const rendered = await renderWithQuery(<Harness scope={scopeKey} />);
    await act(async () => {
      stateBox.current?.uploadFiles([new File(['a'], 'send.png', { type: 'image/png' })]);
    });
    await flushAsync();

    hiddenSnapshot = [...(stateBox.current?.readyAttachments ?? [])];
    expect(hiddenSnapshot).toHaveLength(1);
    const sendScope = 'conversation-send';

    act(() => {
      stateBox.current?.hideAttachments(hiddenSnapshot.map((item) => item.clientAttachmentId));
    });

    // User switches conversations before the send settles.
    scopeKey = 'conversation-other';
    await rendered.rerender(<Harness scope={scopeKey} />);
    expect(rendered.container.querySelector('[data-testid="count"]')?.textContent).toBe('0');

    act(() => {
      stateBox.current?.discardHiddenAttachments(hiddenSnapshot, sendScope);
    });
    expect(revokeObjectURLSpy).toHaveBeenCalledWith('blob:ai-preview-1');

    // Restore path after a failed send should target the captured send scope, not the active one.
    revokeObjectURLSpy.mockClear();
    scopeKey = 'conversation-send-b';
    await rendered.rerender(<Harness scope={scopeKey} />);
    await act(async () => {
      stateBox.current?.uploadFiles([new File(['b'], 'retry.png', { type: 'image/png' })]);
    });
    await flushAsync();
    hiddenSnapshot = [...(stateBox.current?.readyAttachments ?? [])];
    const restoreScope = 'conversation-send-b';

    act(() => {
      stateBox.current?.hideAttachments(hiddenSnapshot.map((item) => item.clientAttachmentId));
    });

    scopeKey = 'conversation-other';
    await rendered.rerender(<Harness scope={scopeKey} />);

    act(() => {
      stateBox.current?.restoreHiddenAttachments(hiddenSnapshot, restoreScope);
    });
    expect(rendered.container.querySelector('[data-testid="count"]')?.textContent).toBe('0');

    scopeKey = restoreScope;
    await rendered.rerender(<Harness scope={scopeKey} />);
    expect(rendered.container.querySelector('[data-testid="count"]')?.textContent).toBe('1');
    expect(revokeObjectURLSpy).not.toHaveBeenCalled();

    rendered.unmount();
  });

});
