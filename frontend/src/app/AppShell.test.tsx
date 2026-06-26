// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AiRenderResponse } from '../api/types';
import { AppNotificationCenter } from './AppShell';

const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
const previousActEnvironment = actEnvironment.IS_REACT_ACT_ENVIRONMENT;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function failedImageJob(overrides: Partial<AiRenderResponse> = {}): AiRenderResponse {
  return {
    job_id: 'image-job-failed',
    status: 'failed',
    error: null,
    generated_asset: null,
    reference_asset: null,
    style_key: null,
    prompt_version: null,
    generation_mode: 'text',
    target_entity_type: 'recipe',
    target_entity_id: 'recipe-1',
    target_entity_name: '板栗烧鸡',
    bind_status: 'pending',
    ...overrides,
  };
}

function renderNotificationCenter(props: Parameters<typeof AppNotificationCenter>[0]) {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  act(() => {
    root?.render(<AppNotificationCenter {...props} />);
  });
  return container;
}

function click(element: Element | null) {
  expect(element).not.toBeNull();
  act(() => {
    element?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

beforeAll(() => {
  actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
});

afterAll(() => {
  actEnvironment.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  document.body.replaceChildren();
  root = null;
  container = null;
});

describe('AppNotificationCenter', () => {
  it('shows a retry action for failed image jobs', () => {
    const onRetryJob = vi.fn();
    const view = renderNotificationCenter({
      jobs: [failedImageJob()],
      onRetryJob,
    });

    click(view.querySelector('.app-notification-trigger'));

    expect(view.textContent).toContain('板栗烧鸡的菜谱图片生成');
    expect(view.textContent).toContain('失败');
    const retryButton = Array.from(view.querySelectorAll('button')).find((button) => button.textContent?.includes('重试'));
    click(retryButton ?? null);

    expect(onRetryJob).toHaveBeenCalledWith('image-job-failed');
  });

  it('closes the popover when clicking outside', () => {
    const view = renderNotificationCenter({
      jobs: [failedImageJob()],
    });
    const outsideButton = document.createElement('button');
    outsideButton.type = 'button';
    outsideButton.textContent = '页面其他位置';
    document.body.append(outsideButton);

    click(view.querySelector('.app-notification-trigger'));
    expect(view.querySelector('.app-notification-popover')).not.toBeNull();

    act(() => {
      outsideButton.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
    });

    expect(view.querySelector('.app-notification-popover')).toBeNull();
  });

  it('keeps every image job in the scrollable notification list', () => {
    const jobs = Array.from({ length: 8 }, (_, index) =>
      failedImageJob({
        job_id: `image-job-${index + 1}`,
        target_entity_id: `recipe-${index + 1}`,
        target_entity_name: `菜谱 ${index + 1}`,
      }),
    );
    const view = renderNotificationCenter({ jobs });

    click(view.querySelector('.app-notification-trigger'));

    expect(view.querySelectorAll('.app-notification-row')).toHaveLength(8);
    expect(view.textContent).toContain('菜谱 8的菜谱图片生成');
  });
});
