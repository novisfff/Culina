// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RecipeDraftDialog } from './RecipeDraftDialog';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

function renderDialog() {
  const onClose = vi.fn();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  act(() => {
    root?.render(
      <RecipeDraftDialog
        aiSourceSummary={[{ label: '菜名', value: '番茄炒蛋' }]}
        form={{ prompt: '清淡少油' }}
        stage="idle"
        statusCopy={{ title: '准备生成', description: '确认后开始补全。' }}
        statusSteps={['生成菜谱', '生成图片']}
        error={null}
        actionLabel="开始生成"
        isBusy={false}
        isImageGenerating={false}
        onChangeForm={vi.fn()}
        onGenerate={vi.fn()}
        onClose={onClose}
      />,
    );
  });
  return { onClose, view: container };
}

describe('RecipeDraftDialog', () => {
  it('uses the shared workspace overlay frame and closes from overlay controls', () => {
    const { onClose, view } = renderDialog();

    expect(view.querySelector('.workspace-overlay-root')).not.toBeNull();
    expect(view.querySelector('.recipe-ai-draft-modal')).not.toBeNull();
    expect(view.textContent).toContain('AI 补全菜谱');

    act(() => view.querySelector<HTMLDivElement>('.workspace-overlay-backdrop')?.click());
    act(() => view.querySelector<HTMLButtonElement>('.workspace-overlay-close')?.click());
    act(() => view.querySelector<HTMLButtonElement>('button.ui-form-actions-secondary')?.click());

    expect(onClose).toHaveBeenCalledTimes(3);
  });
});
