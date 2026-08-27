// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { PropsWithChildren } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ModelUsageBreakdown,
  ModelUsageAlert,
  ModelUsageFamilyBreakdown,
  ModelUsageFamilyBreakdownItem,
  ModelUsageFamilyOverview,
  ModelUsageMeasurementHealth,
  ModelUsagePersonalBreakdown,
  ModelUsagePersonalBreakdownItem,
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

function breakdown(scope: 'me'): ModelUsagePersonalBreakdown;
function breakdown(scope: 'family'): ModelUsageFamilyBreakdown;
function breakdown(scope: 'me' | 'family'): ModelUsageBreakdown {
  const item = {
    label: 'llm',
    capability: 'llm' as const,
    meter: null,
    meter_total: null,
    local_day: null,
    known_priced_cost_cny: '1.500000000000',
    pricing_complete: true,
    unpriced_event_count: 0,
    total_cost_cny: '1.500000000000',
    measurement_health: health(),
  } satisfies ModelUsagePersonalBreakdownItem;
  if (scope === 'me') {
    return {
      family_id: 'family-1',
      scope,
      period: '2026-07',
      source: 'raw',
      is_partial_period: false,
      group_by: 'capability',
      items: [item],
    };
  }
  return {
    family_id: 'family-1',
    scope,
    period: '2026-07',
    source: 'raw',
    is_partial_period: false,
    group_by: 'capability',
    items: [{
      ...item,
      provider: null,
      billing_model: null,
    } satisfies ModelUsageFamilyBreakdownItem],
  };
}

function dailyBreakdown(scope: 'me'): ModelUsagePersonalBreakdown;
function dailyBreakdown(scope: 'family'): ModelUsageFamilyBreakdown;
function dailyBreakdown(scope: 'me' | 'family'): ModelUsageBreakdown {
  const item = {
    label: '2026-07-18 / llm',
    capability: 'llm' as const,
    meter: null,
    meter_total: null,
    local_day: '2026-07-18',
    known_priced_cost_cny: '1.500000000000',
    pricing_complete: true,
    unpriced_event_count: 0,
    total_cost_cny: '1.500000000000',
    measurement_health: health(),
  } satisfies ModelUsagePersonalBreakdownItem;
  if (scope === 'me') {
    return {
      family_id: 'family-1',
      scope,
      period: '2026-07',
      source: 'raw',
      is_partial_period: false,
      group_by: 'daily_capability_cost',
      items: [item],
    };
  }
  return {
    family_id: 'family-1',
    scope,
    period: '2026-07',
    source: 'raw',
    is_partial_period: false,
    group_by: 'daily_capability_cost',
    items: [{
      ...item,
      provider: null,
      billing_model: null,
    } satisfies ModelUsageFamilyBreakdownItem],
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

function usageAlert(overrides: Partial<ModelUsageAlert> = {}): ModelUsageAlert {
  return {
    id: 'alert-1',
    period: '2026-07',
    threshold: '0.800000000000',
    budget_cny: '80.000000000000',
    settled_value: '63.750000000000',
    adjustment_value: '0.250000000000',
    effective_spend_cny: '64.500000000000',
    severity: 'warning',
    seen_at: null,
    dismissed_at: null,
    created_at: '2026-07-18T08:00:00Z',
    ...overrides,
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
    expect(screen.getByText('家庭额度')).toBeVisible();

    await user.click(screen.getByRole('button', { name: '我的' }));

    expect(await screen.findByRole('heading', { name: '我的模型用量' })).toBeVisible();
    expect(screen.queryByText('家庭额度')).not.toBeInTheDocument();
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

      expect(await screen.findByRole('img', { name: '最近 30 天每日模型费用趋势' })).toBeVisible();
      expect(modelUsageApi.getFamilyModelUsageBreakdown).toHaveBeenCalledWith('2026-07', 'capability');
      expect(modelUsageApi.getFamilyModelUsageBreakdown).toHaveBeenCalledWith('2026-07', 'daily_capability_cost');
    } finally {
      vi.useRealTimers();
    }
  });

  it('labels the date trend separately from the selector that controls the breakdown list', async () => {
    resolveOwner();
    modelUsageApi.getFamilyModelUsageBreakdown.mockImplementation((period: string, groupBy: string) =>
      Promise.resolve(groupBy === 'daily_capability_cost' ? dailyBreakdown('family') : breakdown('family')),
    );
    renderWorkspace();

    expect(await screen.findByRole('heading', { name: '每日费用趋势' })).toBeVisible();
    expect(screen.getByText('近 30 天')).toBeVisible();
    expect(screen.getByRole('heading', { name: '费用明细' })).toBeVisible();
    expect(screen.getByLabelText('查看方式')).toBeVisible();
    expect(screen.queryByText('统计维度')).not.toBeInTheDocument();
  });

  it('puts chart insights directly after the period overview and keeps review details before the ledger', async () => {
    resolveOwner();
    modelUsageApi.getModelUsageAlerts.mockResolvedValue([usageAlert()]);
    renderWorkspace();

    const summary = (await screen.findByText('7 月已计入费用')).closest('section');
    const attention = screen.getByRole('heading', { name: '家庭预算已达到 80%' }).closest('section');
    const insights = screen.getByRole('heading', { name: '费用趋势与用量构成' }).closest('section');
    const details = screen.getByRole('heading', { name: '费用明细' }).closest('section');

    const sections = [summary, insights, attention, details];
    expect(sections.every(Boolean)).toBe(true);
    sections.slice(1).forEach((section, index) => {
      const previous = sections[index];
      if (!previous || !section) throw new Error('Expected all model usage sections to render');
      expect(previous.compareDocumentPosition(section) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });
  });

  it('presents the fee breakdown as a scannable ledger section', async () => {
    resolveOwner();
    renderWorkspace();

    const heading = await screen.findByRole('heading', { name: '费用明细' });
    const section = heading.closest('section');

    expect(section).toHaveClass('model-usage-breakdown-ledger');
    const table = within(section as HTMLElement).getByRole('table', { name: '费用明细' });
    expect(table).toHaveClass('model-usage-breakdown-table');
    expect(within(table).getByRole('columnheader', { name: '功能' })).toBeVisible();
    expect(within(table).getByRole('columnheader', { name: '已计入费用' })).toBeVisible();
  });

  it('requests overview, selected breakdown and daily trend for the selected historical month', async () => {
    resolveOwner();
    renderWorkspace();

    await screen.findByRole('heading', { name: '家庭模型用量' });
    fireEvent.change(screen.getByLabelText('选择统计周期'), { target: { value: '2026-06' } });

    await waitFor(() => expect(modelUsageApi.getFamilyModelUsageOverview).toHaveBeenCalledWith('2026-06'));
    expect(modelUsageApi.getFamilyModelUsageBreakdown).toHaveBeenCalledWith('2026-06', 'capability');
    expect(modelUsageApi.getFamilyModelUsageBreakdown).toHaveBeenCalledWith('2026-06', 'daily_capability_cost');
  });

  it('keeps unambiguous meter totals visible in the phone insight view', async () => {
    resolveOwner();
    modelUsageApi.getFamilyModelUsageOverview.mockResolvedValue(familyOverview({
      known_priced_cost_cny: '0.000000000000',
      total_cost_cny: '0.000000000000',
      meter_totals: [{ meter: 'generated_images', quantity: '2.000000000000' }],
    }));
    modelUsageApi.getFamilyModelUsageBreakdown.mockResolvedValue({
      ...breakdown('family'),
      items: [],
    });
    renderWorkspace({ isPhoneViewport: true });

    const meterPanel = (await screen.findByRole('heading', { name: '用量明细' })).closest('article');
    expect(meterPanel).not.toBeNull();
    expect(within(meterPanel as HTMLElement).getByText('生成图片')).toBeVisible();
    expect(within(meterPanel as HTMLElement).getByText('2')).toBeVisible();
  });

  it('shows the actual tracking start for a partial first month', async () => {
    resolveOwner();
    modelUsageApi.getFamilyModelUsageOverview.mockResolvedValue(Object.assign(
      familyOverview({ is_partial_period: true }),
      { tracking_started_at: '2026-07-10T03:00:00Z' },
    ));
    renderWorkspace();

    expect(await screen.findByText('自 2026 年 7 月 10 日起记录')).toBeVisible();
    expect(screen.queryByText(/本月数据不包含此前调用/)).not.toBeInTheDocument();
  });

  it('shows the same accurate partial-period notice on phone', async () => {
    resolveOwner();
    modelUsageApi.getFamilyModelUsageOverview.mockResolvedValue(Object.assign(
      familyOverview({ is_partial_period: true }),
      { tracking_started_at: '2026-07-10T03:00:00Z' },
    ));
    renderWorkspace({ isPhoneViewport: true });

    expect(await screen.findByText('自 2026 年 7 月 10 日起记录')).toBeVisible();
    expect(screen.queryByText(/本月数据不包含此前调用/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '返回家庭页' })).toBeVisible();
  });

  it('keeps exact-only metering quiet instead of rendering an implementation explanation', async () => {
    resolveOwner();
    renderWorkspace();

    expect(await screen.findByRole('heading', { name: '家庭模型用量' })).toBeVisible();
    expect(screen.queryByRole('heading', { name: '计量完整度' })).not.toBeInTheDocument();
    expect(screen.queryByText(/避免把未知情况伪装成精确数据/)).not.toBeInTheDocument();
    expect(screen.queryByText(/暂无需要额外说明的计量状态/)).not.toBeInTheDocument();
  });

  it('shows the actual threshold and amounts for a family budget alert', async () => {
    resolveOwner();
    modelUsageApi.getModelUsageAlerts.mockResolvedValue([usageAlert()]);
    renderWorkspace();

    expect(await screen.findByRole('heading', { name: '家庭预算已达到 80%' })).toBeVisible();
    expect(screen.getAllByText('计入额度').length).toBeGreaterThan(0);
    expect(screen.getByText('¥64.50')).toBeVisible();
    expect(screen.getAllByText('月预算').length).toBeGreaterThan(0);
    expect(screen.getAllByText('¥80.00').length).toBeGreaterThan(0);
    expect(screen.queryByText('家庭额度需要留意')).not.toBeInTheDocument();
  });

  it('keeps the summary amount concise and moves missing-price facts into the review area', async () => {
    resolveOwner();
    modelUsageApi.getFamilyModelUsageOverview.mockResolvedValue(familyOverview({
      known_priced_cost_cny: '12.345000000000',
      pricing_complete: false,
      unpriced_event_count: 1,
      measurement_health: health({ unpriced_event_count: 1 }),
    }));
    renderWorkspace();

    const summary = await screen.findByRole('region', { name: '7 月已计入费用' });
    expect(within(summary).getByText('¥12.35')).toBeVisible();
    expect(within(summary).queryByText(/另有未定价用量/)).not.toBeInTheDocument();
    expect(screen.getByText('1 次请求还没有定价，暂不计入上方费用。')).toBeVisible();
  });

  it('shows a personal budget state once instead of repeating it as another warning', async () => {
    resolveOwner();
    modelUsageApi.getMyModelUsageOverview.mockResolvedValue(personalOverview({
      family_budget_state: 'approaching_limit',
    }));
    const user = userEvent.setup();
    renderWorkspace();

    await user.click(await screen.findByRole('button', { name: '我的' }));

    expect(await screen.findByRole('heading', { name: '我的模型用量' })).toBeVisible();
    expect(screen.getAllByText('接近上限')).toHaveLength(1);
  });

  it('shows provider, model and meter facts in model breakdowns', async () => {
    resolveOwner();
    modelUsageApi.getFamilyModelUsageBreakdown.mockImplementation((period: string, groupBy: string) => {
      if (groupBy === 'provider_model') {
        return Promise.resolve({
          ...breakdown('family'),
          period,
          group_by: 'provider_model' as const,
          items: [{
            ...breakdown('family').items[0],
            label: 'OpenAI / gpt-4.1-mini',
            capability: null,
            provider: 'OpenAI',
            billing_model: 'gpt-4.1-mini',
            meter: 'input_tokens' as const,
            meter_total: '123.000000000000',
          }],
        });
      }
      return Promise.resolve(groupBy === 'daily_capability_cost' ? dailyBreakdown('family') : breakdown('family'));
    });
    renderWorkspace();

    await screen.findByRole('heading', { name: '家庭模型用量' });
    fireEvent.change(screen.getByLabelText('查看方式'), { target: { value: 'provider_model' } });

    const table = await screen.findByRole('table', { name: '费用明细' });
    expect(within(table).getByRole('columnheader', { name: '模型服务' })).toBeVisible();
    expect(within(table).getByRole('columnheader', { name: '用量' })).toBeVisible();
    expect(within(table).getByText('gpt-4.1-mini')).toBeVisible();
    expect(within(table).getByText('OpenAI')).toBeVisible();
    expect(within(table).getByText('123 输入 Token')).toBeVisible();
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

      expect(await screen.findByText('当前离线，以下显示已缓存的数据。')).toBeVisible();
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

    expect(await screen.findByRole('heading', { name: '当前统计周期还没有模型使用记录' })).toBeVisible();
    expect(screen.getByText('使用菜谱生成、图片识别等功能后，费用和用量会自动记录在这里。')).toBeVisible();
    expect(screen.queryByText(/后续使用模型功能后/)).not.toBeInTheDocument();
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
