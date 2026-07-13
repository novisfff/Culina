// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { screen, within } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { AppNotificationCenter, AppShell, type AppNotificationJob } from './AppShell';
import type { PrimaryTabKey } from './appNavigationModel';

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
    created_at: '2026-07-11T10:00:00.000Z',
    completed_at: '2026-07-11T10:05:00.000Z',
    ...overrides,
  };
}

function job(
  status: AppNotificationJob['status'],
  overrides: Partial<AppNotificationJob> = {},
): AppNotificationJob {
  const baseId = overrides.notification_id ?? `image:job-${status}`;
  const isActive = status === 'queued' || status === 'running';
  return {
    notification_id: baseId,
    task_id: overrides.task_id ?? baseId.split(':')[1] ?? baseId,
    kind: overrides.kind ?? 'image',
    status,
    title: overrides.title ?? `${status} job`,
    status_label: overrides.status_label ?? status,
    description: overrides.description ?? status,
    can_retry: status === 'failed',
    can_dismiss: status === 'failed' || status === 'succeeded',
    created_at: overrides.created_at ?? '2026-07-11T10:00:00.000Z',
    completed_at: overrides.completed_at ?? (isActive ? null : '2026-07-11T10:05:00.000Z'),
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

function renderAppShell(children: React.ReactNode, activeTab: PrimaryTabKey = 'home') {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  act(() => {
    root?.render(
      <AppShell
        activeTab={activeTab}
        sidebarCollapsed={false}
        familyName="今天家"
        familyMotto="好好吃饭"
        familyLocation="上海"
        familyMemberLabel="3 人"
        familyActivityLabel="今天有记录"
        userName="小李"
        userSeed="user"
        userMeta="管理员"
        userNote="负责今日晚餐"
        onTabChange={() => undefined}
        onToggleSidebar={() => undefined}
        onOpenProfile={() => undefined}
        onLogout={() => undefined}
      >
        {children}
      </AppShell>,
    );
  });
  return container;
}

function mockVisualViewport({ height, offsetTop }: { height: number; offsetTop: number }) {
  const originalDescriptor = Object.getOwnPropertyDescriptor(window, 'visualViewport');
  const viewport = new EventTarget() as VisualViewport;
  Object.defineProperties(viewport, {
    height: { value: height, writable: true, configurable: true },
    offsetTop: { value: offsetTop, writable: true, configurable: true },
    width: { value: 390, writable: true, configurable: true },
    offsetLeft: { value: 0, writable: true, configurable: true },
    pageLeft: { value: 0, writable: true, configurable: true },
    pageTop: { value: 0, writable: true, configurable: true },
    scale: { value: 1, writable: true, configurable: true },
  });
  Object.defineProperty(window, 'visualViewport', { value: viewport, configurable: true });

  return {
    viewport,
    setMetrics(nextMetrics: { height: number; offsetTop: number }) {
      Object.defineProperties(viewport, {
        height: { value: nextMetrics.height, writable: true, configurable: true },
        offsetTop: { value: nextMetrics.offsetTop, writable: true, configurable: true },
      });
    },
    restore() {
      if (originalDescriptor) {
        Object.defineProperty(window, 'visualViewport', originalDescriptor);
      } else {
        delete (window as unknown as Record<string, unknown>).visualViewport;
      }
    },
  };
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
  document.documentElement.classList.remove('app-mobile-keyboard-open');
  document.documentElement.style.removeProperty('--app-visual-viewport-height');
  document.documentElement.style.removeProperty('--app-visual-viewport-top');
  document.documentElement.style.removeProperty('--app-visual-viewport-bottom-inset');
  document.documentElement.style.removeProperty('--app-visual-viewport-layout-height');
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

  it('does not show a badge when only successful jobs exist', () => {
    const view = renderNotificationCenter({
      jobs: [
        job('succeeded', {
          notification_id: 'image:success-1',
          title: '成功图片生成',
          created_at: '2026-07-11T12:00:00.000Z',
          completed_at: '2026-07-11T12:01:00.000Z',
        }),
      ],
    });

    expect(view.querySelector('.app-notification-count')).toBeNull();
    expect(view.querySelector('.app-notification-trigger')?.getAttribute('aria-label')).toBe('查看后台任务');
  });

  it('badges only active and failed jobs and labels the surface as background tasks', () => {
    const view = renderNotificationCenter({
      jobs: [
        job('succeeded', { notification_id: 'image:success-1', title: '成功 1' }),
        job('succeeded', { notification_id: 'image:success-2', title: '成功 2' }),
        job('running', { notification_id: 'image:running-1', title: '进行中 1', completed_at: null }),
        job('queued', { notification_id: 'search-index:queued-1', kind: 'search_index', title: '排队索引', completed_at: null }),
        job('failed', { notification_id: 'image:failed-1', title: '失败 1' }),
      ],
    });

    const badge = view.querySelector('.app-notification-count');
    expect(badge?.textContent).toBe('3');
    expect(view.querySelector('.app-notification-trigger')?.getAttribute('aria-label')).toBe('查看后台任务，1 个失败，2 个进行中');

    click(view.querySelector('.app-notification-trigger'));
    const popover = view.querySelector('.app-notification-popover');
    expect(popover?.getAttribute('aria-label')).toBe('后台任务');
    expect(popover?.textContent).toContain('后台任务');
  });

  it('keeps all active and failed rows while capping successful history at five newest', () => {
    const succeeded = Array.from({ length: 7 }, (_, index) =>
      job('succeeded', {
        notification_id: `image:success-${index + 1}`,
        title: `成功 ${index + 1}`,
        created_at: `2026-07-11T1${index}:00:00.000Z`,
        completed_at: `2026-07-11T1${index}:05:00.000Z`,
      }),
    );
    const jobs = [
      job('failed', {
        notification_id: 'image:failed-old',
        title: '失败旧',
        completed_at: '2026-07-11T08:00:00.000Z',
      }),
      job('failed', {
        notification_id: 'search-index:failed-new',
        kind: 'search_index',
        title: '失败新',
        completed_at: '2026-07-11T09:00:00.000Z',
      }),
      job('running', {
        notification_id: 'image:running-1',
        title: '运行中',
        created_at: '2026-07-11T09:30:00.000Z',
        completed_at: null,
      }),
      job('queued', {
        notification_id: 'search-index:queued-1',
        kind: 'search_index',
        title: '排队中',
        created_at: '2026-07-11T09:40:00.000Z',
        completed_at: null,
      }),
      ...succeeded,
    ];
    const view = renderNotificationCenter({ jobs });
    click(view.querySelector('.app-notification-trigger'));

    const rows = Array.from(view.querySelectorAll('.app-notification-row'));
    expect(rows).toHaveLength(9);
    const titles = rows.map((row) => row.querySelector('strong')?.textContent ?? '');
    expect(titles.slice(0, 2)).toEqual(['失败新', '失败旧']);
    expect(titles.slice(2, 4)).toEqual(['排队中', '运行中']);
    expect(titles.slice(4)).toEqual(['成功 7', '成功 6', '成功 5', '成功 4', '成功 3']);
    expect(titles).not.toContain('成功 1');
    expect(titles).not.toContain('成功 2');
  });

  it('sorts image and search jobs together by completed_at or created_at rather than source order', () => {
    const view = renderNotificationCenter({
      jobs: [
        job('succeeded', {
          notification_id: 'image:success-old',
          kind: 'image',
          title: '旧成功图片',
          completed_at: '2026-07-11T10:00:00.000Z',
        }),
        job('succeeded', {
          notification_id: 'search-index:success-new',
          kind: 'search_index',
          title: '新成功索引',
          completed_at: '2026-07-11T11:00:00.000Z',
        }),
        job('failed', {
          notification_id: 'search-index:failed-old',
          kind: 'search_index',
          title: '旧失败索引',
          completed_at: '2026-07-11T09:00:00.000Z',
        }),
        job('failed', {
          notification_id: 'image:failed-new',
          kind: 'image',
          title: '新失败图片',
          completed_at: '2026-07-11T12:00:00.000Z',
        }),
      ],
    });
    click(view.querySelector('.app-notification-trigger'));
    const titles = Array.from(view.querySelectorAll('.app-notification-row strong')).map((node) => node.textContent);
    expect(titles).toEqual(['新失败图片', '旧失败索引', '新成功索引', '旧成功图片']);
  });

describe('AppShell primary navigation', () => {
  it('renders the same five primary entries on desktop and mobile', () => {
    renderAppShell(<div>内容</div>, 'eat');
    const expected = ['首页', '吃什么', '食材', 'AI', '家庭'];
    for (const name of ['大屏主导航', '顶部主导航', '手机主导航']) {
      expect(
        within(screen.getByRole('navigation', { name }))
          .getAllByRole('button')
          .map((node) => node.textContent?.trim()),
      ).toEqual(expected);
    }
    expect(screen.queryByRole('button', { name: '菜谱' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '记录' })).not.toBeInTheDocument();
  });
});

describe('AppShell mobile keyboard layout', () => {
  it('renders orientation guidance for tablet/desktop portrait and mobile landscape', () => {
    const view = renderAppShell(<main>工作区内容</main>);

    expect(view.textContent).toContain('电脑和 iPad 端需要横屏查看');
    expect(view.textContent).toContain('手机端需要竖屏查看');
  });

  it('does not keep a keyboard bottom inset when the viewport changes without text focus', () => {
    const rafSpy = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => undefined);
    vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(900);
    const visualViewport = mockVisualViewport({ height: 520, offsetTop: 0 });

    try {
      renderAppShell(<button type="button">普通按钮</button>);

      act(() => {
        visualViewport.viewport.dispatchEvent(new Event('resize'));
      });

      expect(document.documentElement.classList.contains('app-mobile-keyboard-open')).toBe(false);
      expect(document.documentElement.style.getPropertyValue('--app-visual-viewport-bottom-inset')).toBe('0px');
      expect(document.documentElement.style.getPropertyValue('--app-visual-viewport-layout-height')).toBe('520px');
    } finally {
      visualViewport.restore();
      rafSpy.mockRestore();
    }
  });

  it('marks the mobile keyboard as open only while a text field owns focus', () => {
    const rafSpy = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => undefined);
    vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(900);
    const visualViewport = mockVisualViewport({ height: 520, offsetTop: 0 });

    try {
      const view = renderAppShell(<input aria-label="搜索食物" />);
      const input = view.querySelector('input');
      expect(input).not.toBeNull();

      act(() => {
        input?.focus();
        visualViewport.viewport.dispatchEvent(new Event('resize'));
      });

      expect(document.documentElement.classList.contains('app-mobile-keyboard-open')).toBe(true);
      expect(document.documentElement.style.getPropertyValue('--app-visual-viewport-bottom-inset')).toBe('380px');
      expect(document.documentElement.style.getPropertyValue('--app-visual-viewport-layout-height')).toBe('900px');

      visualViewport.setMetrics({ height: 900, offsetTop: 0 });
      act(() => {
        input?.blur();
        visualViewport.viewport.dispatchEvent(new Event('resize'));
      });

      expect(document.documentElement.classList.contains('app-mobile-keyboard-open')).toBe(false);
      expect(document.documentElement.style.getPropertyValue('--app-visual-viewport-bottom-inset')).toBe('0px');
      expect(document.documentElement.style.getPropertyValue('--app-visual-viewport-layout-height')).toBe('900px');
    } finally {
      visualViewport.restore();
      rafSpy.mockRestore();
    }
  });
});
