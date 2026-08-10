// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, type ReactNode } from 'react';
import { renderHook, waitFor } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { api } from '../api/client';
import type { ModelUsageAlert } from '../api/types';
import { useAppNotifications } from './useAppNotifications';

const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
const previousActEnvironment = actEnvironment.IS_REACT_ACT_ENVIRONMENT;

function alert(overrides: Partial<ModelUsageAlert> = {}): ModelUsageAlert {
  return {
    id: 'alert-1',
    period: '2026-07',
    threshold: '0.8',
    budget_cny: '80.000000000000',
    settled_value: '64.000000000000',
    adjustment_value: '0.000000000000',
    effective_spend_cny: '64.000000000000',
    severity: 'warning',
    seen_at: null,
    dismissed_at: null,
    created_at: '2026-07-30T10:00:00.000Z',
    ...overrides,
  };
}

function background() {
  return {
    items: [
      {
        kind: 'background_task' as const,
        notification_id: 'image:job-1',
        task_kind: 'image' as const,
        status: 'running' as const,
        can_retry: false,
        can_dismiss: false,
        error_code: null,
        title: '菜谱图片生成',
        description: '正在处理。',
        occurred_at: '2026-07-30T09:00:00.000Z',
      },
    ],
    isLoading: false,
    dismissJob: vi.fn(),
    retryJob: vi.fn(),
    retryingJobId: null,
  };
}

function createWrapper(client: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

describe('useAppNotifications', () => {
  beforeAll(() => {
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterAll(() => {
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('polls owner alerts every minute and refetches them when the window regains focus', async () => {
    vi.useFakeTimers();
    const getAlerts = vi.spyOn(api, 'getModelUsageAlerts').mockResolvedValue([alert()]);
    const client = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    const { result, unmount } = renderHook(
      () => useAppNotifications({
        enabled: true,
        familyId: 'family-a',
        role: 'Owner',
        background: background(),
      }),
      { wrapper: createWrapper(client) },
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.items.some((item) => item.kind === 'model_usage_alert')).toBe(true);
    const initialCalls = getAlerts.mock.calls.length;

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(getAlerts.mock.calls.length).toBeGreaterThan(initialCalls);
    const callsAfterPolling = getAlerts.mock.calls.length;

    act(() => {
      window.dispatchEvent(new Event('focus'));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(getAlerts.mock.calls.length).toBeGreaterThan(callsAfterPolling);

    unmount();
    client.clear();
  });

  it('never requests or exposes owner alerts for a member', async () => {
    const getAlerts = vi.spyOn(api, 'getModelUsageAlerts').mockResolvedValue([alert()]);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result, unmount } = renderHook(
      () => useAppNotifications({
        enabled: true,
        familyId: 'family-a',
        role: 'Member',
        background: background(),
      }),
      { wrapper: createWrapper(client) },
    );

    await act(async () => {
      await Promise.resolve();
    });
    expect(getAlerts).not.toHaveBeenCalled();
    expect(result.current.items.every((item) => item.kind === 'background_task')).toBe(true);

    unmount();
    client.clear();
  });

  it('marks an alert seen before opening its period and removes it after dismissal', async () => {
    const onOpenModelUsageAlert = vi.fn();
    vi.spyOn(api, 'getModelUsageAlerts').mockResolvedValue([alert()]);
    const markSeen = vi.spyOn(api, 'markModelUsageAlertSeen').mockResolvedValue({
      alert_id: 'alert-1',
      seen_at: '2026-07-30T10:01:00.000Z',
      dismissed_at: null,
    });
    const dismiss = vi.spyOn(api, 'dismissModelUsageAlert').mockResolvedValue({
      alert_id: 'alert-1',
      seen_at: '2026-07-30T10:01:00.000Z',
      dismissed_at: '2026-07-30T10:02:00.000Z',
    });
    const client = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    const { result, unmount } = renderHook(
      () => useAppNotifications({
        enabled: true,
        familyId: 'family-a',
        role: 'Owner',
        background: background(),
        onOpenModelUsageAlert,
      }),
      { wrapper: createWrapper(client) },
    );

    await waitFor(() => expect(result.current.items.some((item) => item.kind === 'model_usage_alert')).toBe(true));
    const notification = result.current.items.find((item) => item.kind === 'model_usage_alert');
    expect(notification?.kind).toBe('model_usage_alert');
    if (!notification || notification.kind !== 'model_usage_alert') throw new Error('missing alert');

    act(() => {
      result.current.openModelUsageAlert(notification);
    });
    expect(onOpenModelUsageAlert).toHaveBeenCalledWith(notification);
    await waitFor(() => expect(markSeen).toHaveBeenCalledWith('alert-1'));
    await waitFor(() => {
      const updated = result.current.items.find((item) => item.kind === 'model_usage_alert');
      expect(updated).toMatchObject({ seen: true });
    });

    act(() => {
      result.current.dismissModelUsageAlert('alert-1');
    });
    await waitFor(() => expect(dismiss).toHaveBeenCalledWith('alert-1'));
    await waitFor(() => expect(result.current.items.some((item) => item.kind === 'model_usage_alert')).toBe(false));

    unmount();
    client.clear();
  });

  it('does not carry an old family alert into a newly selected family', async () => {
    const getAlerts = vi.spyOn(api, 'getModelUsageAlerts')
      .mockResolvedValueOnce([alert({ id: 'alert-family-a', period: '2026-07' })])
      .mockResolvedValueOnce([alert({ id: 'alert-family-b', period: '2026-08' })]);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result, rerender, unmount } = renderHook(
      ({ familyId }) => useAppNotifications({
        enabled: true,
        familyId,
        role: 'Owner',
        background: background(),
      }),
      {
        initialProps: { familyId: 'family-a' },
        wrapper: createWrapper(client),
      },
    );

    await waitFor(() => expect(result.current.items.some((item) => item.notification_id === 'alert-family-a')).toBe(true));
    rerender({ familyId: 'family-b' });

    await waitFor(() => expect(getAlerts).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(result.current.items.some((item) => item.notification_id === 'alert-family-b')).toBe(true));
    expect(result.current.items.some((item) => item.notification_id === 'alert-family-a')).toBe(false);

    unmount();
    client.clear();
  });
});
