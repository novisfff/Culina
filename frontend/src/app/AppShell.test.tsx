// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { AppNotificationCenter, type AppNotificationJob } from './AppShell';

const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
const previousActEnvironment = actEnvironment.IS_REACT_ACT_ENVIRONMENT;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function failedImageJob(overrides: Partial<AppNotificationJob> = {}): AppNotificationJob {
  return {
    notification_id: 'image:image-job-failed',
    task_id: 'image-job-failed',
    kind: 'image',
    status: 'failed',
    title: '板栗烧鸡的菜谱图片生成',
    status_label: '失败',
    description: '生成失败，可以直接重试',
    can_retry: true,
    can_dismiss: true,
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

    expect(onRetryJob).toHaveBeenCalledWith('image:image-job-failed');
  });

  it('shows search index jobs in the same notification list', () => {
    const onRetryJob = vi.fn();
    const view = renderNotificationCenter({
      jobs: [
        failedImageJob({
          notification_id: 'search-index:job-1',
          task_id: 'job-1',
          kind: 'search_index',
          title: '酱油的食材索引更新',
          description: '索引更新失败，可以直接重试',
        }),
      ],
      onRetryJob,
    });

    click(view.querySelector('.app-notification-trigger'));

    expect(view.textContent).toContain('后台任务');
    expect(view.textContent).toContain('酱油的食材索引更新');
    const retryButton = Array.from(view.querySelectorAll('button')).find((button) => button.textContent?.includes('重试'));
    click(retryButton ?? null);

    expect(onRetryJob).toHaveBeenCalledWith('search-index:job-1');
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
        notification_id: `image:image-job-${index + 1}`,
        task_id: `image-job-${index + 1}`,
        title: `菜谱 ${index + 1}的菜谱图片生成`,
      }),
    );
    const view = renderNotificationCenter({ jobs });

    click(view.querySelector('.app-notification-trigger'));

    expect(view.querySelectorAll('.app-notification-row')).toHaveLength(8);
    expect(view.textContent).toContain('菜谱 8的菜谱图片生成');
  });

  it('renders the mobile popover outside the topbar stacking context', () => {
    const view = renderNotificationCenter({
      jobs: [failedImageJob()],
      variant: 'mobileIcon',
    });

    click(view.querySelector('.app-notification-trigger'));

    const popover = document.body.querySelector('.mobile-notification-popover');
    expect(popover).not.toBeNull();
    expect(view.querySelector('.mobile-notification-popover')).toBeNull();

    act(() => {
      popover?.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
    });

    expect(document.body.querySelector('.mobile-notification-popover')).not.toBeNull();
  });
});
