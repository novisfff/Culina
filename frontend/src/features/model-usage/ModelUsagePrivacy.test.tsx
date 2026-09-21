import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor } from '@testing-library/react';
import type { PropsWithChildren } from 'react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ModelUsageFamilyRequestLogPage,
  ModelUsagePersonalBreakdownItem,
  ModelUsagePersonalRequestLogPage,
} from '../../api/types';
import { ModelUsageBreakdownTable } from './ModelUsageBreakdownTable';
import { ModelUsageRequestLogs } from './ModelUsageRequestLogs';
import { ModelUsageRequestLogsPage } from './ModelUsageRequestLogsPage';

const modelUsageApi = vi.hoisted(() => ({
  getMyModelUsageRequests: vi.fn(),
  getFamilyModelUsageRequests: vi.fn(),
}));

vi.mock('../../api/client', () => ({ api: modelUsageApi }));

const personalPage: ModelUsagePersonalRequestLogPage = {
  family_id: 'family-a',
  date_from: '2026-08-01',
  date_to: '2026-08-31',
  scope: 'me',
  source: 'raw',
  total: 1,
  limit: 20,
  offset: 0,
  items: [{
    id: 'request-1',
    occurred_at: '2026-08-18T08:30:00Z',
    capability: 'llm',
    provider_outcome: 'succeeded',
    execution_certainty: 'known',
    measurement_status: 'exact',
    pricing_status: 'priced',
    meters: [{ meter: 'input_tokens', quantity: '12' }],
  }],
};

const personalBreakdownItem: ModelUsagePersonalBreakdownItem = {
  label: '文本与图片理解',
  capability: 'llm',
  meter: null,
  meter_total: null,
  local_day: null,
  known_priced_cost_cny: '1.2',
  pricing_complete: true,
  unpriced_event_count: 0,
  measurement_health: {
    exact_event_count: 1,
    estimated_event_count: 0,
    unpriced_event_count: 0,
    uncertain_attempt_count: 0,
    pending_attempt_count: 0,
    unresolved_unknown_execution_attempt_count: 0,
    known_unmeasured_attempt_count: 0,
    measurement_gap: false,
    conservative_estimated_cost_cny: null,
    measurement_gap_scope: [],
    gap_intervals: [],
  },
};

function wrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: PropsWithChildren) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

describe('ModelUsage privacy boundaries', () => {
  beforeEach(() => {
    modelUsageApi.getMyModelUsageRequests.mockReset();
    modelUsageApi.getFamilyModelUsageRequests.mockReset();
    modelUsageApi.getFamilyModelUsageRequests.mockResolvedValue({ ...personalPage, scope: 'family', items: [] });
    modelUsageApi.getMyModelUsageRequests.mockResolvedValue(personalPage);
  });

  it.each([false, true])('keeps common filters visible and model filters opt-in (phone=%s)', async (isPhoneViewport) => {
    const user = userEvent.setup();
    render(<ModelUsageRequestLogsPage familyId="family-a" role="Owner" initialPeriod="2026-08"
      isPhoneViewport={isPhoneViewport} onBack={() => undefined} />, { wrapper: wrapper() });
    await waitFor(() => expect(modelUsageApi.getFamilyModelUsageRequests).toHaveBeenCalled());
    expect(screen.getByRole('button', { name: '模型功能' })).toBeVisible();
    expect(screen.getByRole('button', { name: '核对状态' })).toBeVisible();
    expect(screen.getByRole('button', { name: '更多筛选' })).toHaveAttribute('aria-expanded', 'false');
    await user.click(screen.getByRole('button', { name: '更多筛选' }));
    await user.type(screen.getByLabelText('模型'), 'test-model');
    expect(modelUsageApi.getFamilyModelUsageRequests).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/已应用：/)).not.toHaveTextContent('test-model');
    await user.click(screen.getByRole('button', { name: '查看记录' }));
    await waitFor(() => expect(modelUsageApi.getFamilyModelUsageRequests).toHaveBeenLastCalledWith(expect.objectContaining({ model: 'test-model' })));
    expect(screen.getByText(/已应用：/)).toHaveTextContent('test-model');
    await user.click(screen.getByRole('button', { name: '清除筛选' }));
    expect(screen.getByLabelText('模型')).toHaveValue('');
    expect(screen.getByText(/已应用：/)).not.toHaveTextContent('test-model');
  });

  it('keeps a return path and filters when request loading fails', async () => {
    modelUsageApi.getMyModelUsageRequests.mockRejectedValue(new Error('offline'));
    const onBack = vi.fn();
    const user = userEvent.setup();
    render(<ModelUsageRequestLogsPage familyId="family-a" role="Member" initialPeriod="2026-08"
      isPhoneViewport={false} onBack={onBack} />, { wrapper: wrapper() });
    await screen.findByText('请求记录加载失败');
    expect(screen.getByRole('region', { name: '请求记录筛选' })).toBeVisible();
    await user.click(screen.getByRole('button', { name: '返回模型用量' }));
    expect(onBack).toHaveBeenCalledWith({ period: '2026-08', scope: 'me' });
  });

  it('shows every meter directly while retaining the personal projection', () => {
    render(<ModelUsageRequestLogs page={{ ...personalPage, items: [{ ...personalPage.items[0], meters: [
      { meter: 'input_tokens', quantity: '10' }, { meter: 'output_tokens', quantity: '20' },
      { meter: 'cached_input_tokens', quantity: '30' }, { meter: 'total_tokens', quantity: '60' },
    ] }] }} />);
    expect(screen.queryByText('查看用量明细')).not.toBeInTheDocument();
    expect(screen.getByText('总文本用量')).toBeVisible();
    expect(screen.getByText('60')).toBeVisible();
  });

  it.each([
    ['0', 'priced', '¥0.00'],
    [null, 'priced', '费用待确认'],
    [null, 'unpriced', '未定价'],
  ])('distinguishes fee %s with pricing %s', (cost, pricing, label) => {
    render(<ModelUsageRequestLogs page={{ ...personalPage, scope: 'family', items: [{
      ...personalPage.items[0], provider: 'private', requested_model: 'private', billing_model: 'private',
      cost_cny: cost, pricing_status: pricing!,
    }] }} />);
    expect(screen.getByText(label!)).toBeVisible();
  });

  it('shows readable usage without internal identifiers in family records', () => {
    const page: ModelUsageFamilyRequestLogPage = {
      ...personalPage, scope: 'family', items: [{
        ...personalPage.items[0], capability: 'image_generation',
        provider: 'family-model-profile-secret', requested_model: 'gpt-image-2', billing_model: 'gpt-image-2',
        subject_label: 'mus_private-id', provider_request_id: 'private-request-id', cost_cny: null,
        measurement_status: 'estimated', meters: [{ meter: 'generated_images', quantity: '1' }],
      }],
    };
    const { container } = render(<ModelUsageRequestLogs page={page} />);
    expect(screen.queryByText('查看用量明细')).not.toBeInTheDocument();
    expect(container.textContent).not.toMatch(/family-model-profile|mus_private|private-request|gpt-image/);
    expect(screen.getByText('费用待确认')).toBeVisible();
    expect(screen.getByText('1 张')).toBeVisible();
    expect(screen.getByText('估算用量')).toBeVisible();
    expect(screen.queryByText('已定价')).not.toBeInTheDocument();
  });

  it('removes diagnostic filters and request parameters in personal scope', async () => {
    render(
      <ModelUsageRequestLogsPage
        familyId="family-a"
        role="Owner"
        initialPeriod="2026-08"
        isPhoneViewport={false}
        onBack={() => undefined}
      />,
      { wrapper: wrapper() },
    );

    await waitFor(() => expect(modelUsageApi.getFamilyModelUsageRequests).toHaveBeenCalled());
    await act(async () => {
      screen.getByRole('button', { name: '我的' }).click();
    });

    await waitFor(() => expect(modelUsageApi.getMyModelUsageRequests).toHaveBeenCalled());
    expect(screen.queryByLabelText('Provider')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('模型')).not.toBeInTheDocument();
    expect(modelUsageApi.getMyModelUsageRequests).toHaveBeenLastCalledWith(expect.not.objectContaining({
      provider: expect.anything(),
      model: expect.anything(),
    }));
  });

  it('does not read diagnostic fields from personal records or breakdowns', () => {
    const pageWithUnexpectedDiagnosticFields = {
      ...personalPage,
      items: [{
        ...personalPage.items[0],
        provider: 'private-provider',
        billing_model: 'private-model',
        provider_request_id: 'private-request',
        cost_cny: '8.88',
      }],
    } as unknown as ModelUsagePersonalRequestLogPage;
    const breakdownWithUnexpectedDiagnosticFields = {
      ...personalBreakdownItem,
      provider: 'private-provider',
      billing_model: 'private-model',
    } as unknown as ModelUsagePersonalBreakdownItem;
    const PersonalBreakdownTable = ModelUsageBreakdownTable as unknown as (props: {
      scope: 'me';
      groupBy: 'capability';
      items: ModelUsagePersonalBreakdownItem[];
    }) => ReturnType<typeof ModelUsageBreakdownTable>;

    const rendered = render(
      <>
        <ModelUsageRequestLogs page={pageWithUnexpectedDiagnosticFields} />
        <PersonalBreakdownTable
          scope="me"
          groupBy="capability"
          items={[breakdownWithUnexpectedDiagnosticFields]}
        />
      </>,
    );

    expect(rendered.container.textContent).not.toContain('private-provider');
    expect(rendered.container.textContent).not.toContain('private-model');
    expect(rendered.container.textContent).not.toContain('private-request');
    expect(rendered.container.textContent).not.toContain('¥8.88');
  });
});
