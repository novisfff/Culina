import React, { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { AiQualityDiagnosticsModal } from './AiQualityDiagnosticsModal';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

function renderModal() {
  const onClose = vi.fn();
  const onRetry = vi.fn();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root?.render(
      <AiQualityDiagnosticsModal
        metrics={null}
        isLoading={false}
        isError={false}
        onRetry={onRetry}
        onClose={onClose}
      />,
    );
  });
  return { onClose, onRetry, view: container };
}

describe('AiQualityDiagnosticsModal', () => {
  it('uses the shared workspace overlay frame and closes from overlay controls', () => {
    const { onClose, view } = renderModal();

    expect(view.querySelector('.workspace-overlay-root.ai-quality-modal-root')).not.toBeNull();
    expect(view.textContent).toContain('AI 质量诊断');
    expect(view.textContent).toContain('还没有运行记录');

    act(() => view.querySelector<HTMLDivElement>('.workspace-overlay-backdrop')?.click());
    act(() => view.querySelector<HTMLButtonElement>('.workspace-overlay-close')?.click());

    expect(onClose).toHaveBeenCalledTimes(2);
  });
});
