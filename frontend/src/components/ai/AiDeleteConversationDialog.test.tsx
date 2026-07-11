// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AiDeleteConversationDialog } from './AiDeleteConversationDialog';
import { conversation } from './aiWorkspaceTestFixtures';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.clearAllMocks();
});

function renderDialog() {
  const onCancel = vi.fn();
  const onConfirm = vi.fn();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  act(() => {
    root?.render(
      <AiDeleteConversationDialog
        conversation={conversation()}
        isDeleting={false}
        onCancel={onCancel}
        onConfirm={onConfirm}
      />,
    );
  });
  return { onCancel, onConfirm, view: container };
}

describe('AiDeleteConversationDialog', () => {
  it('uses shared confirmation chrome without legacy delete body classes', () => {
    const { onCancel, onConfirm, view } = renderDialog();

    expect(view.querySelector('.workspace-overlay-root.ai-delete-confirm-root')).not.toBeNull();
    expect(view.querySelector('.workspace-modal.ai-delete-confirm-modal')).not.toBeNull();
    expect(view.querySelector('.ui-form-actions.ai-delete-confirm-actions')).not.toBeNull();
    expect(view.querySelector('.ai-delete-confirm-body')).toBeNull();
    expect(view.querySelector('.ai-delete-confirm-icon')).toBeNull();

    act(() => view.querySelector<HTMLButtonElement>('.ai-delete-confirm-actions .solid-button')?.click());
    expect(onConfirm).toHaveBeenCalledTimes(1);

    act(() => view.querySelector<HTMLButtonElement>('.workspace-overlay-close')?.click());
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
