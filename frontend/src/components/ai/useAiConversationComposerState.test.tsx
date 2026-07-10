import React, { act } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanupTestDomAndMocks, renderWithQuery } from '../../test/renderWithQuery';
import { useAiConversationComposerState } from './useAiConversationComposerState';

type ComposerState = ReturnType<typeof useAiConversationComposerState>;

afterEach(() => {
  cleanupTestDomAndMocks();
});

describe('useAiConversationComposerState', () => {
  it('keeps drafts isolated and remaps only the requested conversation', async () => {
    const stateBox: { current: ComposerState | null } = { current: null };
    function Harness() {
      stateBox.current = useAiConversationComposerState('conversation-a');
      return <span data-testid="draft">{stateBox.current.draft}</span>;
    }
    const rendered = await renderWithQuery(<Harness />);
    act(() => stateBox.current?.setDraft('A 的草稿'));
    act(() => stateBox.current?.selectScope('conversation-b'));
    expect(rendered.container.textContent).toBe('');
    act(() => stateBox.current?.setDraft('B 的草稿'));
    act(() => stateBox.current?.moveScope('conversation-a', 'conversation-server-a'));
    act(() => stateBox.current?.selectScope('conversation-server-a'));
    expect(rendered.container.textContent).toBe('A 的草稿');
    rendered.unmount();
  });

  it('clears only the requested conversation draft', async () => {
    const stateBox: { current: ComposerState | null } = { current: null };
    function Harness() {
      stateBox.current = useAiConversationComposerState('conversation-a');
      return <span data-testid="draft">{stateBox.current.draft}</span>;
    }
    const rendered = await renderWithQuery(<Harness />);
    act(() => stateBox.current?.setDraft('A 的草稿'));
    act(() => stateBox.current?.selectScope('conversation-b'));
    act(() => stateBox.current?.setDraft('B 的草稿'));
    act(() => stateBox.current?.clearScope('conversation-a'));
    act(() => stateBox.current?.selectScope('conversation-a'));
    expect(rendered.container.textContent).toBe('');
    act(() => stateBox.current?.selectScope('conversation-b'));
    expect(rendered.container.textContent).toBe('B 的草稿');
    rendered.unmount();
  });

  it('updates the active scope when moving the selected conversation', async () => {
    const stateBox: { current: ComposerState | null } = { current: null };
    function Harness() {
      stateBox.current = useAiConversationComposerState('new-ai-conversation');
      return <span data-testid="draft">{stateBox.current.draft}</span>;
    }
    const rendered = await renderWithQuery(<Harness />);
    act(() => stateBox.current?.setDraft('新建草稿'));
    act(() => stateBox.current?.moveScope('new-ai-conversation', 'pending-conversation-1'));
    expect(stateBox.current?.scope).toBe('pending-conversation-1');
    expect(rendered.container.textContent).toBe('新建草稿');
    rendered.unmount();
  });
});
