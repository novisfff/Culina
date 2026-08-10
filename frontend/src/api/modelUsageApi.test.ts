import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockRequest = vi.fn();

vi.mock('./request', () => ({
  request: (...args: unknown[]) => mockRequest(...args),
}));

import { api } from './client';
import { modelUsageApi } from './modelUsageApi';

describe('modelUsageApi transport', () => {
  beforeEach(() => {
    mockRequest.mockReset();
  });

  it('loads personal and family overviews for an explicit billing period', async () => {
    mockRequest.mockResolvedValue({});

    await modelUsageApi.getMyModelUsageOverview('2026-07');
    expect(mockRequest).toHaveBeenLastCalledWith('/api/model-usage/me/overview?period=2026-07');

    await modelUsageApi.getFamilyModelUsageOverview('2026-07');
    expect(mockRequest).toHaveBeenLastCalledWith('/api/model-usage/family/overview?period=2026-07');
  });

  it('loads scoped breakdowns with the selected grouping', async () => {
    mockRequest.mockResolvedValue({});

    await modelUsageApi.getMyModelUsageBreakdown('2026-06', 'meter');
    expect(mockRequest).toHaveBeenLastCalledWith(
      '/api/model-usage/me/breakdown?period=2026-06&group_by=meter',
    );

    await modelUsageApi.getFamilyModelUsageBreakdown('2026-06', 'daily_capability_cost');
    expect(mockRequest).toHaveBeenLastCalledWith(
      '/api/model-usage/family/breakdown?period=2026-06&group_by=daily_capability_cost',
    );
  });

  it('loads request logs by an explicit date range without a billing period', async () => {
    mockRequest.mockResolvedValue({});

    await modelUsageApi.getFamilyModelUsageRequests({
      date_from: '2026-07-28',
      date_to: '2026-08-03',
      limit: 20,
      offset: 0,
    });

    const url = String(mockRequest.mock.calls.at(-1)?.[0]);
    expect(url).toContain('/api/model-usage/family/requests?');
    expect(url).toContain('date_from=2026-07-28');
    expect(url).toContain('date_to=2026-08-03');
    expect(url).not.toContain('period=');
  });

  it('gets and updates the family policy while preserving decimal strings for OCC', async () => {
    mockRequest.mockResolvedValue({ version_number: 3, monthly_budget_cny: '80.000000000000' });

    await modelUsageApi.getFamilyModelUsagePolicy();
    expect(mockRequest).toHaveBeenLastCalledWith('/api/model-usage/family/policy');

    const payload = {
      base_version_number: 2,
      monthly_budget_cny: '80.005000000000',
      alerts_enabled: true,
      hard_limit_enabled: false,
      capability_limits: [
        {
          capability: 'llm' as const,
          limit_kind: 'cost' as const,
          meter: null,
          limit_value: '12.345000000000',
          enabled: true,
        },
      ],
      confirm_missing_price_impact: false,
    };
    await modelUsageApi.updateFamilyModelUsagePolicy(payload);

    expect(mockRequest).toHaveBeenLastCalledWith('/api/model-usage/family/policy', {
      method: 'PUT',
      body: JSON.stringify(payload),
    });
    expect(JSON.parse(mockRequest.mock.calls.at(-1)?.[1]?.body as string)).toMatchObject({
      monthly_budget_cny: '80.005000000000',
      capability_limits: [expect.objectContaining({ limit_value: '12.345000000000' })],
    });
  });

  it('lists and acknowledges owner alerts', async () => {
    mockRequest.mockResolvedValue([]);

    await modelUsageApi.getModelUsageAlerts();
    expect(mockRequest).toHaveBeenLastCalledWith('/api/model-usage/alerts');

    await modelUsageApi.markModelUsageAlertSeen('alert-1');
    expect(mockRequest).toHaveBeenLastCalledWith('/api/model-usage/alerts/alert-1/seen', {
      method: 'POST',
    });

    await modelUsageApi.dismissModelUsageAlert('alert-1');
    expect(mockRequest).toHaveBeenLastCalledWith('/api/model-usage/alerts/alert-1/dismiss', {
      method: 'POST',
    });
  });

  it('is exposed through the central API client', async () => {
    mockRequest.mockResolvedValue({});

    await api.getMyModelUsageOverview('2026-07');

    expect(mockRequest).toHaveBeenCalledWith('/api/model-usage/me/overview?period=2026-07');
  });
});
