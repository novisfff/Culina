// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../api/client';
import type { AiRenderResponse, SearchIndexJobResponse } from '../api/types';
import { useAiImageJobMonitor } from './useAiImageJobMonitor';

function budgetBlockedSearchIndexJob(): SearchIndexJobResponse {
  return {
    job_id: 'search-index-job-1',
    status: 'budget_blocked',
    error: '当前家庭的模型用量预算已到上限',
    error_code: 'model_usage_budget_exceeded',
    entity_type: 'ingredient',
    entity_id: 'ingredient-1',
    target_name: '酱油',
    vector_status: 'pending',
    created_at: '2026-07-30T00:00:00Z',
    completed_at: null,
  };
}

function nonRetryableFailedImageJob(): AiRenderResponse & { can_retry: boolean } {
  return {
    job_id: 'image-job-uncertain-1',
    status: 'failed',
    error: '图片生成服务的执行结果暂时无法确认；为避免重复生成，本次不会自动重试。',
    error_code: 'image_provider_outcome_uncertain',
    can_retry: false,
    generation_mode: 'text',
    target_entity_type: 'food',
    bind_status: 'pending',
    created_at: '2026-07-30T00:00:00Z',
    completed_at: '2026-07-30T00:01:00Z',
  };
}

describe('useAiImageJobMonitor', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('labels a budget-blocked search index job accurately and keeps it active for automatic recovery', async () => {
    vi.spyOn(api, 'getActiveAiRenderJobs').mockResolvedValue([]);
    vi.spyOn(api, 'getActiveSearchIndexJobs').mockResolvedValue([budgetBlockedSearchIndexJob()]);
    const client = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );

    const { result, unmount } = renderHook(() => useAiImageJobMonitor(true), { wrapper });

    await waitFor(() => expect(result.current.jobs).toHaveLength(1));

    expect(result.current.jobs[0]).toMatchObject({
      status: 'budget_blocked',
      status_label: '受预算限制',
      description: '当前家庭的模型用量预算已到上限',
      can_retry: false,
      can_dismiss: false,
    });

    unmount();
    client.clear();
  });

  it('does not offer retry for an image job with an uncertain provider outcome', async () => {
    vi.spyOn(api, 'getActiveAiRenderJobs').mockResolvedValue([nonRetryableFailedImageJob()]);
    vi.spyOn(api, 'getActiveSearchIndexJobs').mockResolvedValue([]);
    const client = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );

    const { result, unmount } = renderHook(() => useAiImageJobMonitor(true), { wrapper });

    await waitFor(() => expect(result.current.jobs).toHaveLength(1));

    expect(result.current.jobs[0]).toMatchObject({
      status: 'failed',
      can_retry: false,
      description: '图片生成服务的执行结果暂时无法确认；为避免重复生成，本次不会自动重试。',
    });

    unmount();
    client.clear();
  });
});
