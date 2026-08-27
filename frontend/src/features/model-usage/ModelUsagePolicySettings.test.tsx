// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { PropsWithChildren } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../api/request';
import type {
  ModelUsageBreakdown,
  ModelUsageFamilyOverview,
  ModelUsageMeasurementHealth,
  ModelUsagePolicy,
} from '../../api/types';
import { ModelUsageWorkspace } from './ModelUsageWorkspace';

const modelUsageApi = vi.hoisted(() => ({
  getMyModelUsageOverview: vi.fn(),
  getMyModelUsageBreakdown: vi.fn(),
  getFamilyModelUsageOverview: vi.fn(),
  getFamilyModelUsageBreakdown: vi.fn(),
  getFamilyModelUsagePolicy: vi.fn(),
  getModelUsageAlerts: vi.fn(),
  updateFamilyModelUsagePolicy: vi.fn(),
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

function familyOverview(overrides: Partial<ModelUsageFamilyOverview> = {}): ModelUsageFamilyOverview {
  return {
    family_id: 'family-1',
    scope: 'family',
    period: '2026-07',
    source: 'raw',
    is_partial_period: false,
    known_priced_cost_cny: '1.500000000000',
    pricing_complete: true,
    unpriced_event_count: 0,
    total_cost_cny: '1.500000000000',
    meter_totals: [{ meter: 'input_tokens', quantity: '120.000000000000' }],
    measurement_health: health(),
    monthly_budget_cny: '80.000000000000',
    effective_spend_cny: '1.500000000000',
    reserved_cost_cny: '0.250000000000',
    hard_limit_enabled: false,
    ...overrides,
  };
}

function breakdown(groupBy: ModelUsageBreakdown['group_by'] = 'capability'): ModelUsageBreakdown {
  return {
    family_id: 'family-1',
    scope: 'family',
    period: '2026-07',
    source: 'raw',
    is_partial_period: false,
    group_by: groupBy,
    items: [],
  };
}

function policy(overrides: Partial<ModelUsagePolicy> = {}): ModelUsagePolicy {
  return {
    version_number: 3,
    monthly_budget_cny: '80.005000000000',
    alerts_enabled: true,
    hard_limit_enabled: false,
    budget_alert_revision: 2,
    capability_limits: [],
    effective_at: '2026-07-01T00:00:00Z',
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

function renderPolicySettings(props: Partial<React.ComponentProps<typeof ModelUsageWorkspace>> = {}) {
  const queryClient = createQueryClient();
  function Wrapper(wrapperProps: PropsWithChildren) {
    return <QueryClientProvider client={queryClient}>{wrapperProps.children}</QueryClientProvider>;
  }
  return render(
    <ModelUsageWorkspace
      familyId="family-1"
      role="Owner"
      isPhoneViewport={false}
      onBack={vi.fn()}
      {...props}
    />,
    { wrapper: Wrapper },
  );
}

function resolveOwner() {
  modelUsageApi.getFamilyModelUsageOverview.mockResolvedValue(familyOverview());
  modelUsageApi.getFamilyModelUsageBreakdown.mockImplementation((_period: string, groupBy: ModelUsageBreakdown['group_by']) =>
    Promise.resolve(breakdown(groupBy)),
  );
  modelUsageApi.getFamilyModelUsagePolicy.mockResolvedValue(policy());
  modelUsageApi.getModelUsageAlerts.mockResolvedValue([]);
}

describe('ModelUsagePolicySettings', () => {
  beforeEach(() => {
    Object.values(modelUsageApi).forEach((mock) => mock.mockReset());
  });

  it('uses a drawer on desktop and a full page on phone', async () => {
    resolveOwner();
    const user = userEvent.setup();
    const desktop = renderPolicySettings({ isPhoneViewport: false });

    await screen.findByRole('heading', { name: '家庭模型用量' });
    await user.click(screen.getByRole('button', { name: '预算设置' }));
    expect(screen.getByRole('dialog', { name: '模型预算设置' })).toHaveClass('workspace-drawer');

    desktop.unmount();
    const phone = renderPolicySettings({ isPhoneViewport: true });
    await screen.findByRole('heading', { name: '家庭模型用量' });
    await user.click(screen.getByRole('button', { name: '预算设置' }));

    expect(screen.getByRole('main', { name: '模型预算设置' })).toBeVisible();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    phone.unmount();
  });

  it('keeps the settings surface recoverable when the policy query fails', async () => {
    resolveOwner();
    modelUsageApi.getFamilyModelUsagePolicy.mockRejectedValueOnce(new Error('service unavailable'));
    const user = userEvent.setup();
    const view = renderPolicySettings();

    await screen.findByRole('heading', { name: '家庭模型用量' });
    await user.click(screen.getByRole('button', { name: '预算设置' }));
    expect(await screen.findByText('模型预算设置暂时不可用')).toBeVisible();

    await user.click(screen.getByRole('button', { name: '重新加载' }));
    expect(await screen.findByLabelText('家庭月预算（元）')).toHaveValue('80.005');
    view.unmount();
  });

  it('shows a concise policy summary and hides storage precision from the editable budget', async () => {
    resolveOwner();
    const user = userEvent.setup();
    const view = renderPolicySettings();

    await screen.findByRole('heading', { name: '家庭模型用量' });
    await user.click(screen.getByRole('button', { name: '预算设置' }));

    const summary = screen.getByRole('region', { name: '当前预算策略' });
    expect(summary).toHaveTextContent('¥80.01');
    expect(summary).toHaveTextContent('预算提醒已开启');
    expect(summary).toHaveTextContent('超额停止未开启');
    expect(summary).toHaveTextContent('0 项功能限额');
    expect(screen.getByLabelText('家庭月预算（元）')).toHaveValue('80.005');
    view.unmount();
  });

  it('preserves edited Decimal text and sends null when an owner clears an optional monthly budget', async () => {
    resolveOwner();
    modelUsageApi.updateFamilyModelUsagePolicy.mockResolvedValue(policy({ monthly_budget_cny: null }));
    const user = userEvent.setup();
    const view = renderPolicySettings();

    await screen.findByRole('heading', { name: '家庭模型用量' });
    await user.click(screen.getByRole('button', { name: '预算设置' }));

    const budget = screen.getByLabelText('家庭月预算（元）');
    expect(budget).toHaveValue('80.005');
    await user.clear(budget);
    await user.click(screen.getByRole('button', { name: '保存设置' }));

    await waitFor(() => expect(screen.queryByRole('dialog', { name: '模型预算设置' })).not.toBeInTheDocument());
    expect(modelUsageApi.updateFamilyModelUsagePolicy).toHaveBeenCalledWith(expect.objectContaining({
      monthly_budget_cny: null,
      confirm_missing_price_impact: false,
    }));
    view.unmount();
  });

  it('requires a positive monthly budget before it sends a hard-limit policy', async () => {
    resolveOwner();
    modelUsageApi.getFamilyModelUsagePolicy.mockResolvedValue(policy({ monthly_budget_cny: null }));
    const user = userEvent.setup();
    const view = renderPolicySettings();

    await screen.findByRole('heading', { name: '家庭模型用量' });
    await user.click(screen.getByRole('button', { name: '预算设置' }));
    expect(screen.queryByText('保存后，新发起的模型请求会按新额度检查；已经开始的请求，以及用量记录服务异常期间已经允许的请求，仍可能完成并计入本月用量。')).not.toBeInTheDocument();
    expect(screen.queryByText(/Decimal|持久化发送授权|放行凭证/)).not.toBeInTheDocument();
    await user.click(screen.getByRole('checkbox', { name: '达到上限后暂停新请求' }));
    expect(screen.getByText('保存后，新发起的模型请求会按新额度检查；已经开始的请求，以及用量记录服务异常期间已经允许的请求，仍可能完成并计入本月用量。')).toBeVisible();
    await user.click(screen.getByRole('button', { name: '保存设置' }));

    expect(screen.getByText('开启限制前，请先填写大于 0 的家庭月预算。')).toBeVisible();
    expect(modelUsageApi.updateFamilyModelUsagePolicy).not.toHaveBeenCalled();
    view.unmount();
  });

  it('keeps one guardrail per capability and only offers meters that capability can produce', async () => {
    resolveOwner();
    modelUsageApi.updateFamilyModelUsagePolicy.mockResolvedValue(policy());
    const user = userEvent.setup();
    const view = renderPolicySettings();

    await screen.findByRole('heading', { name: '家庭模型用量' });
    await user.click(screen.getByRole('button', { name: '预算设置' }));
    expect(screen.getByRole('button', { name: '展开文本与图片理解限额设置' })).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByLabelText('文本与图片理解限额类型')).not.toBeInTheDocument();
    await user.click(screen.getByRole('checkbox', { name: '文本与图片理解限额' }));
    expect(screen.getByRole('button', { name: '收起文本与图片理解限额设置' })).toHaveAttribute('aria-expanded', 'true');
    await user.selectOptions(screen.getByLabelText('文本与图片理解限额类型'), 'meter');

    expect(screen.getByLabelText('文本与图片理解用量类型')).toHaveValue('input_tokens');
    expect(screen.queryByRole('option', { name: '生成图片' })).not.toBeInTheDocument();
    const limit = screen.getByLabelText('文本与图片理解限额上限');
    await user.clear(limit);
    await user.type(limit, '120.005000000000');
    await user.click(screen.getByRole('button', { name: '保存设置' }));

    await waitFor(() => expect(screen.queryByRole('dialog', { name: '模型预算设置' })).not.toBeInTheDocument());
    expect(modelUsageApi.updateFamilyModelUsagePolicy).toHaveBeenCalledWith(expect.objectContaining({
      capability_limits: [{
        capability: 'llm',
        limit_kind: 'meter',
        meter: 'input_tokens',
        limit_value: '120.005',
        enabled: true,
      }],
    }));
    view.unmount();
  });

  it('requires an explicit missing-price confirmation before retrying a hard-limit save', async () => {
    resolveOwner();
    modelUsageApi.updateFamilyModelUsagePolicy
      .mockRejectedValueOnce(new ApiError({
        status: 422,
        detail: '请确认缺价影响',
        path: '/api/model-usage/family/policy',
        payload: { detail: { code: 'model_usage_missing_price_confirmation_required' } },
      }))
      .mockResolvedValueOnce(policy({ hard_limit_enabled: true }));
    const user = userEvent.setup();
    const view = renderPolicySettings();

    await screen.findByRole('heading', { name: '家庭模型用量' });
    await user.click(screen.getByRole('button', { name: '预算设置' }));
    await user.click(screen.getByRole('checkbox', { name: '达到上限后暂停新请求' }));
    await user.click(screen.getByRole('button', { name: '保存设置' }));

    const confirmation = await screen.findByRole('checkbox', { name: '我知道保存后，没有价格信息的新请求会被阻止。' });
    expect(screen.getByRole('button', { name: '保存设置' })).toBeDisabled();
    expect(modelUsageApi.updateFamilyModelUsagePolicy).toHaveBeenCalledWith(expect.objectContaining({
      hard_limit_enabled: true,
      confirm_missing_price_impact: false,
    }));

    await user.click(confirmation);
    await user.click(screen.getByRole('button', { name: '保存设置' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '模型预算设置' })).not.toBeInTheDocument());

    expect(modelUsageApi.updateFamilyModelUsagePolicy).toHaveBeenLastCalledWith(expect.objectContaining({
      hard_limit_enabled: true,
      confirm_missing_price_impact: true,
    }));
    view.unmount();
  });

  it('does not submit a hard-limit retry through the form before missing-price impact is confirmed', async () => {
    resolveOwner();
    modelUsageApi.updateFamilyModelUsagePolicy
      .mockRejectedValueOnce(new ApiError({
        status: 422,
        detail: '请确认缺价影响',
        path: '/api/model-usage/family/policy',
        payload: { detail: { code: 'model_usage_missing_price_confirmation_required' } },
      }))
      .mockResolvedValueOnce(policy({ hard_limit_enabled: true }));
    const user = userEvent.setup();
    const view = renderPolicySettings();

    await screen.findByRole('heading', { name: '家庭模型用量' });
    await user.click(screen.getByRole('button', { name: '预算设置' }));
    await user.click(screen.getByRole('checkbox', { name: '达到上限后暂停新请求' }));
    await user.click(screen.getByRole('button', { name: '保存设置' }));
    await screen.findByRole('checkbox', { name: '我知道保存后，没有价格信息的新请求会被阻止。' });

    fireEvent.submit(screen.getByLabelText('家庭月预算（元）').closest('form')!);

    await waitFor(() => expect(modelUsageApi.updateFamilyModelUsagePolicy).toHaveBeenCalledTimes(1));
    expect(screen.getByRole('dialog', { name: '模型预算设置' })).toBeVisible();
    view.unmount();
  });

  it('retains the draft and gives a Chinese retry path after an ordinary save error', async () => {
    resolveOwner();
    modelUsageApi.updateFamilyModelUsagePolicy.mockRejectedValue(new Error('offline'));
    const user = userEvent.setup();
    const view = renderPolicySettings();

    await screen.findByRole('heading', { name: '家庭模型用量' });
    await user.click(screen.getByRole('button', { name: '预算设置' }));
    const budget = screen.getByLabelText('家庭月预算（元）');
    expect(budget).toHaveValue('80.005');
    await user.clear(budget);
    await waitFor(() => expect(budget).toHaveValue(''));
    await user.type(budget, '95.005000000000');
    await waitFor(() => expect(budget).toHaveValue('95.005000000000'));
    await user.click(screen.getByRole('button', { name: '保存设置' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('设置还没有保存');
    expect(screen.getByText('当前修改已保留，请检查设置后重试。')).toBeVisible();
    expect(screen.getByLabelText('家庭月预算（元）')).toHaveValue('95.005000000000');
    expect(screen.getByRole('button', { name: '保存设置' })).toBeEnabled();
    view.unmount();
  });

  it('keeps an OCC draft until the owner explicitly reapplies it to the current policy version', async () => {
    const currentPolicy = policy({
      version_number: 4,
      monthly_budget_cny: '90.000000000000',
      hard_limit_enabled: true,
      capability_limits: [{
        capability: 'llm',
        limit_kind: 'cost',
        meter: null,
        limit_value: '12.000000000000',
        enabled: true,
      }],
    });
    resolveOwner();
    modelUsageApi.getFamilyModelUsagePolicy
      .mockResolvedValueOnce(policy())
      .mockResolvedValue(currentPolicy);
    modelUsageApi.updateFamilyModelUsagePolicy
      .mockRejectedValueOnce(new ApiError({
        status: 409,
        detail: '预算设置已更新',
        path: '/api/model-usage/family/policy',
        payload: {
          detail: {
            code: 'model_usage_policy_conflict',
            current_policy: currentPolicy,
            current_version_number: 4,
            recovery_hint: 'review_current_policy_and_reapply',
          },
        },
      }))
      .mockResolvedValueOnce(policy({ version_number: 5, monthly_budget_cny: '95.005000000000' }));
    const user = userEvent.setup();
    const view = renderPolicySettings();

    await screen.findByRole('heading', { name: '家庭模型用量' });
    await user.click(screen.getByRole('button', { name: '预算设置' }));
    const budget = screen.getByLabelText('家庭月预算（元）');
    await user.clear(budget);
    await user.type(budget, '95.005000000000');
    expect(budget).toHaveValue('95.005000000000');
    await user.click(screen.getByRole('button', { name: '保存设置' }));

    const conflict = await screen.findByRole('status', { name: '预算设置冲突' });
    expect(conflict).toHaveTextContent('预算设置已被更新');
    expect(conflict).toHaveTextContent('你的修改仍然保留。先查看最新设置，再决定是否重新应用。');
    expect(conflict).not.toHaveTextContent('当前版本：4');
    expect(conflict).toHaveTextContent('家庭月预算：¥90.00');
    expect(conflict).toHaveTextContent('已开启超额停止');
    expect(conflict).toHaveTextContent('1 项功能限额');
    expect(screen.getByLabelText('家庭月预算（元）')).toHaveValue('95.005000000000');

    await user.click(screen.getByRole('button', { name: '查看最新设置' }));
    await waitFor(() => expect(modelUsageApi.getFamilyModelUsagePolicy).toHaveBeenCalledTimes(2));
    await user.click(screen.getByRole('button', { name: '重新应用保留的修改' }));
    await user.click(screen.getByRole('button', { name: '保存设置' }));

    await waitFor(() => expect(screen.queryByRole('dialog', { name: '模型预算设置' })).not.toBeInTheDocument());
    expect(modelUsageApi.updateFamilyModelUsagePolicy).toHaveBeenLastCalledWith(expect.objectContaining({
      base_version_number: 4,
      monthly_budget_cny: '95.005000000000',
    }));
    view.unmount();
  });

  it('locks the desktop drawer controls and close paths while a policy save is pending', async () => {
    resolveOwner();
    let resolveSave: ((value: ModelUsagePolicy) => void) | undefined;
    const pendingSave = new Promise<ModelUsagePolicy>((resolve) => {
      resolveSave = resolve;
    });
    modelUsageApi.updateFamilyModelUsagePolicy.mockImplementation(() => pendingSave);
    const user = userEvent.setup();
    const view = renderPolicySettings();

    await screen.findByRole('heading', { name: '家庭模型用量' });
    await user.click(screen.getByRole('button', { name: '预算设置' }));
    await user.click(screen.getByRole('button', { name: '保存设置' }));

    expect(await screen.findByRole('button', { name: '正在保存设置…' })).toBeDisabled();
    expect(screen.getByLabelText('家庭月预算（元）')).toBeDisabled();
    expect(screen.getByRole('checkbox', { name: '达到上限后暂停新请求' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '关闭弹窗' })).toBeDisabled();

    fireEvent.click(document.querySelector('.workspace-overlay-backdrop')!);
    fireEvent.keyDown(document, { key: 'Escape', bubbles: true });
    await user.click(screen.getByRole('button', { name: '正在保存设置…' }));
    expect(screen.getByRole('dialog', { name: '模型预算设置' })).toBeVisible();
    expect(modelUsageApi.updateFamilyModelUsagePolicy).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveSave?.(policy());
    });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '模型预算设置' })).not.toBeInTheDocument());
    view.unmount();
  });

  it('disables the full-screen phone back action while a policy save is pending', async () => {
    resolveOwner();
    let resolveSave: ((value: ModelUsagePolicy) => void) | undefined;
    const pendingSave = new Promise<ModelUsagePolicy>((resolve) => {
      resolveSave = resolve;
    });
    modelUsageApi.updateFamilyModelUsagePolicy.mockImplementation(() => pendingSave);
    const user = userEvent.setup();
    const view = renderPolicySettings({ isPhoneViewport: true });

    await screen.findByRole('heading', { name: '家庭模型用量' });
    await user.click(screen.getByRole('button', { name: '预算设置' }));
    expect(screen.getByText('家庭额度管理')).toBeVisible();
    await user.click(screen.getByRole('button', { name: '保存设置' }));

    expect(await screen.findByRole('button', { name: '正在保存设置…' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '返回模型用量' })).toBeDisabled();
    expect(screen.getByRole('main', { name: '模型预算设置' })).toBeVisible();
    expect(modelUsageApi.updateFamilyModelUsagePolicy).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveSave?.(policy());
    });
    await screen.findByRole('heading', { name: '家庭模型用量' });
    view.unmount();
  });
});
