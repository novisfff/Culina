// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { PropsWithChildren } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ModelUsageBreakdown,
  ModelUsageFamilyOverview,
  ModelUsageMeasurementHealth,
  ModelUsagePersonalOverview,
  ModelUsagePolicy,
} from '../../api/types';
import { queryKeys } from '../../api/queryKeys';
import { ModelUsageWorkspace } from './ModelUsageWorkspace';

const modelUsageApi = vi.hoisted(() => ({
  getMyModelUsageOverview: vi.fn(),
  getMyModelUsageBreakdown: vi.fn(),
  getFamilyModelUsageOverview: vi.fn(),
  getFamilyModelUsageBreakdown: vi.fn(),
  getFamilyModelUsagePolicy: vi.fn(),
  getModelUsageAlerts: vi.fn(),
}));

vi.mock('../../api/client', () => ({ api: modelUsageApi }));

function health(overrides: Partial<ModelUsageMeasurementHealth> = {}): ModelUsageMeasurementHealth {
  return {
    exact_event_count: 1,
    estimated_event_count: 0,
    unpriced_event_count: 0,
    uncertain_attempt_count: 0,
    pending_attempt_count: 0,
    unresolved_unknown_execution_attempt_count: 0,
    conservative_estimated_cost_cny: null,
    known_unmeasured_attempt_count: 0,
    measurement_gap: false,
    measurement_gap_scope: [],
    gap_intervals: [],
    ...overrides,
  };
}

function personalOverview(overrides: Partial<ModelUsagePersonalOverview> = {}): ModelUsagePersonalOverview {
  return {
    family_id: 'family-1',
    scope: 'me',
    period: '2026-07',
    source: 'raw',
    is_partial_period: false,
    known_priced_cost_cny: '1.500000000000',
    pricing_complete: true,
    unpriced_event_count: 0,
    total_cost_cny: '1.500000000000',
    meter_totals: [{ meter: 'input_tokens', quantity: '120.000000000000' }],
    measurement_health: health(),
    family_budget_state: 'sufficient',
    ...overrides,
  };
}

function familyOverview(overrides: Partial<ModelUsageFamilyOverview> = {}): ModelUsageFamilyOverview {
  return {
    ...personalOverview(),
    scope: 'family',
    monthly_budget_cny: '80.000000000000',
    effective_spend_cny: '1.500000000000',
    reserved_cost_cny: '0.250000000000',
    hard_limit_enabled: true,
    ...overrides,
  };
}

function breakdown(scope: 'me' | 'family'): ModelUsageBreakdown {
  return {
    family_id: 'family-1',
    scope,
    period: '2026-07',
    source: 'raw',
    is_partial_period: false,
    group_by: 'capability',
    items: [{
      label: 'llm',
      capability: 'llm',
      provider: null,
      billing_model: null,
      meter: null,
      meter_total: null,
      local_day: null,
      known_priced_cost_cny: '1.500000000000',
      pricing_complete: true,
      unpriced_event_count: 0,
      total_cost_cny: '1.500000000000',
      measurement_health: health(),
    }],
  };
}

function dailyBreakdown(scope: 'me' | 'family'): ModelUsageBreakdown {
  return {
    ...breakdown(scope),
    group_by: 'daily_capability_cost',
    items: [{
      label: '2026-07-18 / llm',
      capability: 'llm',
      provider: null,
      billing_model: null,
      meter: null,
      meter_total: null,
      local_day: '2026-07-18',
      known_priced_cost_cny: '1.500000000000',
      pricing_complete: true,
      unpriced_event_count: 0,
      total_cost_cny: '1.500000000000',
      measurement_health: health(),
    }],
  };
}

function policy(): ModelUsagePolicy {
  return {
    version_number: 1,
    monthly_budget_cny: '80.000000000000',
    alerts_enabled: true,
    hard_limit_enabled: true,
    budget_alert_revision: 1,
    capability_limits: [],
    effective_at: '2026-07-01T00:00:00Z',
  };
}

function createQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
}

function renderWorkspace(props: Partial<React.ComponentProps<typeof ModelUsageWorkspace>> = {}) {
  const queryClient = createQueryClient();
  function Wrapper(wrapperProps: PropsWithChildren) {
    return <QueryClientProvider client={queryClient}>{wrapperProps.children}</QueryClientProvider>;
  }
  return {
    queryClient,
    ...render(
    <ModelUsageWorkspace
      familyId="family-1"
      role="Owner"
      isPhoneViewport={false}
      onBack={vi.fn()}
      {...props}
    />,
    { wrapper: Wrapper },
    ),
  };
}

function resolveOwner() {
  modelUsageApi.getFamilyModelUsageOverview.mockResolvedValue(familyOverview());
  modelUsageApi.getFamilyModelUsageBreakdown.mockResolvedValue(breakdown('family'));
  modelUsageApi.getMyModelUsageOverview.mockResolvedValue(personalOverview());
  modelUsageApi.getMyModelUsageBreakdown.mockResolvedValue(breakdown('me'));
  modelUsageApi.getFamilyModelUsagePolicy.mockResolvedValue(policy());
  modelUsageApi.getModelUsageAlerts.mockResolvedValue([]);
}

describe('ModelUsageWorkspace', () => {
  beforeEach(() => {
    Object.values(modelUsageApi).forEach((mock) => mock.mockReset());
  });

  it('lets owners switch between family and personal usage without showing family budget on the personal scope', async () => {
    resolveOwner();
    const user = userEvent.setup();
    renderWorkspace();

    expect(await screen.findByRole('heading', { name: '家庭模型用量' })).toBeVisible();
    expect(screen.getByText('家庭月预算')).toBeVisible();

    await user.click(screen.getByRole('button', { name: '我的' }));

    expect(await screen.findByRole('heading', { name: '我的模型用量' })).toBeVisible();
    expect(screen.queryByText('家庭月预算')).not.toBeInTheDocument();
  });

  it('loads the daily trend alongside the default capability breakdown', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date('2026-07-30T03:00:00.000Z'));
    try {
      resolveOwner();
      modelUsageApi.getFamilyModelUsageBreakdown.mockImplementation((period: string, groupBy: string) =>
        Promise.resolve(groupBy === 'daily_capability_cost' ? dailyBreakdown('family') : breakdown('family')),
      );
      renderWorkspace();

      expect(await screen.findByRole('img', { name: '本月每日模型费用趋势' })).toBeVisible();
      expect(modelUsageApi.getFamilyModelUsageBreakdown).toHaveBeenCalledWith('2026-07', 'capability');
      expect(modelUsageApi.getFamilyModelUsageBreakdown).toHaveBeenCalledWith('2026-07', 'daily_capability_cost');
    } finally {
      vi.useRealTimers();
    }
  });

  it('requests overview, selected breakdown and daily trend for the selected historical month', async () => {
    resolveOwner();
    renderWorkspace();

    await screen.findByRole('heading', { name: '家庭模型用量' });
    fireEvent.change(screen.getByLabelText('选择账期'), { target: { value: '2026-06' } });

    await waitFor(() => expect(modelUsageApi.getFamilyModelUsageOverview).toHaveBeenCalledWith('2026-06'));
    expect(modelUsageApi.getFamilyModelUsageBreakdown).toHaveBeenCalledWith('2026-06', 'capability');
    expect(modelUsageApi.getFamilyModelUsageBreakdown).toHaveBeenCalledWith('2026-06', 'daily_capability_cost');
  });

  it('uses the same capability meter fallback on phone as on desktop', async () => {
    resolveOwner();
    modelUsageApi.getFamilyModelUsageOverview.mockResolvedValue(familyOverview({
      known_priced_cost_cny: '0.000000000000',
      total_cost_cny: '0.000000000000',
      meter_totals: [{ meter: 'input_tokens', quantity: '120.000000000000' }],
    }));
    modelUsageApi.getFamilyModelUsageBreakdown.mockResolvedValue({
      ...breakdown('family'),
      items: [],
    });
    renderWorkspace({ isPhoneViewport: true });

    expect(await screen.findByText('120 输入 Token')).toBeVisible();
  });

  it('shows the actual tracking start for a partial first month', async () => {
    resolveOwner();
    modelUsageApi.getFamilyModelUsageOverview.mockResolvedValue(Object.assign(
      familyOverview({ is_partial_period: true }),
      { tracking_started_at: '2026-07-10T03:00:00Z' },
    ));
    renderWorkspace();

    expect(await screen.findByText('统计从 2026 年 7 月 10 日开始，本月数据不包含此前调用。')).toBeVisible();
  });

  it('shows the same accurate partial-period notice on phone', async () => {
    resolveOwner();
    modelUsageApi.getFamilyModelUsageOverview.mockResolvedValue(Object.assign(
      familyOverview({ is_partial_period: true }),
      { tracking_started_at: '2026-07-10T03:00:00Z' },
    ));
    renderWorkspace({ isPhoneViewport: true });

    expect(await screen.findByText('统计从 2026 年 7 月 10 日开始，本月数据不包含此前调用。')).toBeVisible();
    expect(screen.getByRole('button', { name: '返回家庭页' })).toBeVisible();
  });

  it('keeps ordinary members on personal usage and never renders family scope controls or amounts', async () => {
    modelUsageApi.getMyModelUsageOverview.mockResolvedValue(personalOverview());
    modelUsageApi.getMyModelUsageBreakdown.mockResolvedValue(breakdown('me'));
    renderWorkspace({ role: 'Member' });

    expect(await screen.findByRole('heading', { name: '我的模型用量' })).toBeVisible();
    expect(screen.queryByRole('button', { name: '家庭' })).not.toBeInTheDocument();
    expect(screen.queryByText('家庭月预算')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '预算设置' })).not.toBeInTheDocument();
    await waitFor(() => expect(modelUsageApi.getFamilyModelUsageOverview).not.toHaveBeenCalled());
    expect(modelUsageApi.getFamilyModelUsagePolicy).not.toHaveBeenCalled();
  });

  it('labels cached data when an offline refresh fails', async () => {
    resolveOwner();
    const originalOnline = navigator.onLine;
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: false });
    try {
      const { queryClient } = renderWorkspace({ initialPeriod: '2026-07' });
      expect(await screen.findByRole('heading', { name: '家庭模型用量' })).toBeVisible();

      modelUsageApi.getFamilyModelUsageOverview.mockRejectedValueOnce(new Error('offline'));
      await act(async () => {
        await queryClient.invalidateQueries({
          queryKey: queryKeys.modelUsageOverview('family-1', 'family', '2026-07'),
        });
      });

      expect(await screen.findByText('当前离线，正在显示已缓存的数据。')).toBeVisible();
      expect(screen.getByRole('heading', { name: '家庭模型用量' })).toBeVisible();
    } finally {
      Object.defineProperty(navigator, 'onLine', { configurable: true, value: originalOnline });
    }
  });

  it('keeps an empty usage month distinct from a failed load', async () => {
    resolveOwner();
    modelUsageApi.getFamilyModelUsageOverview.mockResolvedValue(familyOverview({
      known_priced_cost_cny: '0.000000000000',
      total_cost_cny: '0.000000000000',
      meter_totals: [],
      measurement_health: health({ exact_event_count: 0 }),
    }));
    modelUsageApi.getFamilyModelUsageBreakdown.mockResolvedValue({ ...breakdown('family'), items: [] });
    renderWorkspace();

    expect(await screen.findByText('这个账期暂无模型用量')).toBeVisible();
    expect(screen.queryByText('模型用量加载失败')).not.toBeInTheDocument();
  });

  it('shows a recoverable full error when no overview data can be loaded', async () => {
    modelUsageApi.getFamilyModelUsageOverview.mockRejectedValue(new Error('service unavailable'));
    modelUsageApi.getFamilyModelUsageBreakdown.mockResolvedValue(breakdown('family'));
    modelUsageApi.getFamilyModelUsagePolicy.mockResolvedValue(policy());
    modelUsageApi.getModelUsageAlerts.mockResolvedValue([]);
    renderWorkspace();

    expect(await screen.findByText('模型用量加载失败')).toBeVisible();
    expect(screen.getByRole('button', { name: '重新加载' })).toBeVisible();
  });

  it('returns to family from the no-context state without starting usage requests', async () => {
    const onBack = vi.fn();
    const user = userEvent.setup();
    renderWorkspace({ familyId: '', onBack });

    expect(screen.getByText('暂时没有家庭上下文')).toBeVisible();
    await user.click(screen.getByRole('button', { name: '返回家庭' }));

    expect(onBack).toHaveBeenCalledTimes(1);
    expect(modelUsageApi.getFamilyModelUsageOverview).not.toHaveBeenCalled();
    expect(modelUsageApi.getMyModelUsageOverview).not.toHaveBeenCalled();
  });
});
