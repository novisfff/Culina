// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { screen, within } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  AppNotificationCenter,
  AppShell,
  groupAppNotifications,
  type BackgroundTaskNotification,
} from './AppShell';
import type { PrimaryTabKey } from './appNavigationModel';

const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
const previousActEnvironment = actEnvironment.IS_REACT_ACT_ENVIRONMENT;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function failedImageJob(overrides: Partial<BackgroundTaskNotification> = {}): BackgroundTaskNotification {
  return {
    notification_id: 'image:image-job-failed',
    kind: 'background_task',
    task_kind: 'image',
    status: 'failed',
    title: '板栗烧鸡的菜谱图片生成',
    description: '生成失败，可以直接重试',
    can_retry: true,
    can_dismiss: true,
    error_code: null,
    occurred_at: '2026-07-11T10:05:00.000Z',
    ...overrides,
  };
}

function job(
  status: BackgroundTaskNotification['status'],
  overrides: Partial<BackgroundTaskNotification> = {},
): BackgroundTaskNotification {
  const baseId = overrides.notification_id ?? `image:job-${status}`;
  const isActive = status === 'queued' || status === 'running';
  return {
    notification_id: baseId,
    kind: 'background_task',
    task_kind: overrides.task_kind ?? 'image',
    status,
    title: overrides.title ?? `${status} job`,
    description: overrides.description ?? status,
    can_retry: status === 'failed',
    can_dismiss: status === 'failed' || status === 'succeeded',
    error_code: overrides.error_code ?? null,
    occurred_at: overrides.occurred_at ?? (isActive ? '2026-07-11T10:00:00.000Z' : '2026-07-11T10:05:00.000Z'),
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
    const onRetryBackgroundTask = vi.fn();
    const view = renderNotificationCenter({
      items: [failedImageJob()],
      onRetryBackgroundTask,
    });

    click(view.querySelector('.app-notification-trigger'));

    expect(view.textContent).toContain('板栗烧鸡的菜谱图片生成');
    expect(view.textContent).toContain('失败，可重试');
    const retryButton = Array.from(view.querySelectorAll('button')).find((button) => button.textContent?.includes('重试'));
    click(retryButton ?? null);

    expect(onRetryBackgroundTask).toHaveBeenCalledWith('image:image-job-failed');
  });

  it('shows a search index task in the same notification list', () => {
    const onRetryBackgroundTask = vi.fn();
    const view = renderNotificationCenter({
      items: [
        failedImageJob({
          notification_id: 'search-index:job-1',
          task_kind: 'search_index',
          title: '酱油的食材索引更新',
          description: '索引更新失败，可以直接重试',
        }),
      ],
      onRetryBackgroundTask,
    });

    click(view.querySelector('.app-notification-trigger'));

    expect(view.textContent).toContain('通知');
    expect(view.textContent).toContain('酱油的食材索引更新');
    const retryButton = Array.from(view.querySelectorAll('button')).find((button) => button.textContent?.includes('重试'));
    click(retryButton ?? null);

    expect(onRetryBackgroundTask).toHaveBeenCalledWith('search-index:job-1');
  });

  it('uses separate native controls to open and dismiss an owner usage alert', () => {
    const onOpenModelUsageAlert = vi.fn();
    const onDismissModelUsageAlert = vi.fn();
    const view = renderNotificationCenter({
      items: [{
        kind: 'model_usage_alert',
        notification_id: 'alert-1',
        alert_id: 'alert-1',
        severity: 'critical',
        period: '2026-07',
        seen: false,
        title: '模型用量需要处理',
        description: '请查看模型用量，必要时调整预算或限额。',
        occurred_at: '2026-07-30T10:00:00.000Z',
      }],
      onOpenModelUsageAlert,
      onDismissModelUsageAlert,
    });

    click(view.querySelector('.app-notification-trigger'));
    const openAlertButton = view.querySelector<HTMLButtonElement>('.app-notification-open');
    expect(openAlertButton?.tagName).toBe('BUTTON');
    expect(view.querySelector('[role="button"].app-notification-row')).toBeNull();
    click(openAlertButton ?? null);
    expect(onOpenModelUsageAlert).toHaveBeenCalledWith(expect.objectContaining({ alert_id: 'alert-1', period: '2026-07' }));
    expect(view.querySelector('.app-notification-popover')).toBeNull();

    click(view.querySelector('.app-notification-trigger'));
    click(Array.from(view.querySelectorAll('button')).find((button) => button.getAttribute('aria-label') === '清除模型用量需要处理通知') ?? null);
    expect(onDismissModelUsageAlert).toHaveBeenCalledWith('alert-1');
  });

  it('closes the popover on Escape and outside click', () => {
    const view = renderNotificationCenter({ items: [failedImageJob()] });
    const outsideButton = document.createElement('button');
    outsideButton.type = 'button';
    outsideButton.textContent = '页面其他位置';
    document.body.append(outsideButton);

    click(view.querySelector('.app-notification-trigger'));
    act(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(view.querySelector('.app-notification-popover')).toBeNull();

    click(view.querySelector('.app-notification-trigger'));
    act(() => outsideButton.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true })));
    expect(view.querySelector('.app-notification-popover')).toBeNull();
  });

  it('renders the mobile popover outside the topbar stacking context', () => {
    const view = renderNotificationCenter({ items: [failedImageJob()], variant: 'mobileIcon' });

    click(view.querySelector('.app-notification-trigger'));

    const popover = document.body.querySelector('.mobile-notification-popover');
    expect(popover).not.toBeNull();
    expect(view.querySelector('.mobile-notification-popover')).toBeNull();
  });

  it('moves focus into the mobile portal and restores its trigger after Escape', () => {
    const view = renderNotificationCenter({
      items: [failedImageJob()],
      variant: 'mobileIcon',
      onRetryBackgroundTask: vi.fn(),
    });
    const trigger = view.querySelector<HTMLButtonElement>('.app-notification-trigger');
    expect(trigger).not.toBeNull();

    act(() => trigger?.focus());
    click(trigger);

    const retry = document.body.querySelector<HTMLButtonElement>('[aria-label="重试板栗烧鸡的菜谱图片生成"]');
    expect(document.activeElement).toBe(retry);

    act(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(document.activeElement).toBe(trigger);
  });

  it('does not show a badge when only successful jobs exist', () => {
    const view = renderNotificationCenter({
      items: [job('succeeded', { notification_id: 'image:success-1', title: '成功图片生成', occurred_at: '2026-07-11T12:01:00.000Z' })],
    });

    expect(view.querySelector('.app-notification-count')).toBeNull();
    expect(view.querySelector('.app-notification-trigger')?.getAttribute('aria-label')).toBe('查看通知');
  });

  it('badges attention and active items and renders fixed group headings', () => {
    const view = renderNotificationCenter({
      items: [
        job('succeeded', { notification_id: 'image:success-1', title: '成功 1' }),
        job('running', { notification_id: 'image:running-1', title: '进行中 1' }),
        job('queued', { notification_id: 'search-index:queued-1', task_kind: 'search_index', title: '排队索引' }),
        job('failed', { notification_id: 'image:failed-1', title: '失败 1' }),
      ],
    });

    expect(view.querySelector('.app-notification-count')?.textContent).toBe('3');
    expect(view.querySelector('.app-notification-trigger')?.getAttribute('aria-label')).toBe('查看通知，1 项需要处理，2 项进行中');

    click(view.querySelector('.app-notification-trigger'));
    const popover = view.querySelector('.app-notification-popover');
    expect(popover?.getAttribute('aria-label')).toBe('通知');
    expect(Array.from(view.querySelectorAll('.app-notification-group-title')).map((node) => node.textContent)).toEqual([
      '需要处理',
      '进行中',
      '最近完成',
    ]);
  });
});

describe('groupAppNotifications', () => {
  it('orders attention before progress and completion with deterministic recency and capped history', () => {
    const timestamp = '2026-07-30T10:00:00.000Z';
    const groups = groupAppNotifications([
      {
        kind: 'model_usage_alert', notification_id: 'alert-a', alert_id: 'alert-a', severity: 'warning', period: '2026-07', seen: false,
        title: '模型用量达到提醒线', description: '请查看模型用量。', occurred_at: timestamp,
      },
      {
        kind: 'model_usage_alert', notification_id: 'alert-b', alert_id: 'alert-b', severity: 'critical', period: '2026-07', seen: false,
        title: '模型用量需要处理', description: '请查看模型用量。', occurred_at: timestamp,
      },
      job('failed', { notification_id: 'image:failed', occurred_at: '2026-07-30T09:00:00.000Z' }),
      job('running', { notification_id: 'image:running', occurred_at: '2026-07-30T08:00:00.000Z' }),
      ...Array.from({ length: 6 }, (_, index) => job('succeeded', {
        notification_id: `image:success-${index}`,
        occurred_at: `2026-07-30T0${index}:00:00.000Z`,
      })),
    ]);

    expect(groups.map((group) => group.key)).toEqual(['needs_attention', 'in_progress', 'recently_completed']);
    expect(groups[0]?.items.map((item) => item.notification_id)).toEqual(['alert-b', 'alert-a', 'image:failed']);
    expect(groups[1]?.items.map((item) => item.notification_id)).toEqual(['image:running']);
    expect(groups[2]?.items).toHaveLength(5);
    expect(groups[2]?.items.map((item) => item.notification_id)).not.toContain('image:success-0');
  });

  it('keeps all attention and active rows while capping successful history and sorting by occurrence', () => {
    const items = [
      job('failed', { notification_id: 'image:failed-old', title: '失败旧', occurred_at: '2026-07-11T08:00:00.000Z' }),
      job('failed', { notification_id: 'search-index:failed-new', task_kind: 'search_index', title: '失败新', occurred_at: '2026-07-11T09:00:00.000Z' }),
      job('running', { notification_id: 'image:running-1', title: '运行中', occurred_at: '2026-07-11T09:30:00.000Z' }),
      job('queued', { notification_id: 'search-index:queued-1', task_kind: 'search_index', title: '排队中', occurred_at: '2026-07-11T09:40:00.000Z' }),
      ...Array.from({ length: 7 }, (_, index) => job('succeeded', {
        notification_id: `image:success-${index + 1}`,
        title: `成功 ${index + 1}`,
        occurred_at: `2026-07-11T1${index}:05:00.000Z`,
      })),
    ];

    const grouped = groupAppNotifications(items);
    expect(grouped.flatMap((group) => group.items).map((item) => item.title)).toEqual([
      '失败新', '失败旧', '排队中', '运行中', '成功 7', '成功 6', '成功 5', '成功 4', '成功 3',
    ]);
  });
});

describe('AppShell primary navigation', () => {
  it('keeps the desktop information order and centers AI on mobile', () => {
    renderAppShell(<div>内容</div>, 'eat');
    const desktopExpected = ['首页', '吃什么', '食材', 'AI', '家庭'];
    for (const name of ['侧边导航', '顶部导航', '底部导航']) {
      const expected = name === '底部导航'
        ? ['首页', '吃什么', 'AI', '食材', '家庭']
        : desktopExpected;
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
  it('keeps tablet portrait workspaces available while retaining mobile landscape guidance', () => {
    const view = renderAppShell(<main>工作区内容</main>);

    expect(view.textContent).not.toContain('电脑和 iPad 端需要横屏查看');
    expect(screen.queryByRole('region', { name: '请横屏使用 Culina' })).not.toBeInTheDocument();
    expect(view.textContent).toContain('竖屏查看效果更好');
    expect(screen.getByRole('region', { name: '请竖屏使用 Culina' })).toBeInTheDocument();
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
