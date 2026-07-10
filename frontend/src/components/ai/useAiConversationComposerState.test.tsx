import React, { act } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanupTestDomAndMocks, renderWithQuery } from '../../test/renderWithQuery';
import { useAiConversationComposerState } from './useAiConversationComposerState';

afterEach(() => {
  cleanupTestDomAndMocks();
});

describe('useAiConversationComposerState', () => {
  it('keeps drafts isolated and remaps only the requested conversation', async () => {
    let state: ReturnType<typeof useAiConversationComposerState> | null = null;
    function Harness() {
      state = useAiConversationComposerState('conversation-a');
      return <span data-testid="draft">{state.draft}</span>;
    }
    const rendered = await renderWithQuery(<Harness />);
    act(() => state?.setDraft('A 的草稿'));
    act(() => state?.selectScope('conversation-b'));
    expect(rendered.container.textContent).toBe('');
    act(() => state?.setDraft('B 的草稿'));
    act(() => state?.moveScope('conversation-a', 'conversation-server-a'));
    act(() => state?.selectScope('conversation-server-a'));
    expect(rendered.container.textContent).toBe('A 的草稿');
    rendered.unmount();
  });

  it('clears only the requested conversation draft', async () => {
    let state: ReturnType<typeof useAiConversationComposerState> | null = null;
    function Harness() {
      state = useAiConversationComposerState('conversation-a');
      return <span data-testid="draft">{state.draft}</span>;
    }
    const rendered = await renderWithQuery(<Harness />);
    act(() => state?.setDraft('A 的草稿'));
    act(() => state?.selectScope('conversation-b'));
    act(() => state?.setDraft('B 的草稿'));
    act(() => state?.clearScope('conversation-a'));
    act(() => state?.selectScope('conversation-a'));
    expect(rendered.container.textContent).toBe('');
    act(() => state?.selectScope('conversation-b'));
    expect(rendered.container.textContent).toBe('B 的草稿');
    rendered.unmount();
  });

  it('updates the active scope when moving the selected conversation', async () => {
    let state: ReturnType<typeof useAiConversationComposerState> | null = null;
    function Harness() {
      state = useAiConversationComposerState('new-ai-conversation');
      return <span data-testid="draft">{state.draft}</span>;
    }
    const rendered = await renderWithQuery(<Harness />);
    act(() => state?.setDraft('新建草稿'));
    act(() => state?.moveScope('new-ai-conversation', 'pending-conversation-1'));
    expect(state?.scope).toBe('pending-conversation-1');
    expect(rendered.container.textContent).toBe('新建草稿');
    rendered.unmount();
  });
});
