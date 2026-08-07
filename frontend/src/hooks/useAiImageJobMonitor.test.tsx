// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../api/client';
import type { AiRenderResponse, SearchIndexJobResponse } from '../api/types';
import { imageJobNotification, useAiImageJobMonitor } from './useAiImageJobMonitor';

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

  it('normalizes a budget-blocked search index job into non-retryable attention', async () => {
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

    await waitFor(() => expect(result.current.items).toHaveLength(1));

    expect(result.current.items[0]).toMatchObject({
      kind: 'background_task',
      task_kind: 'search_index',
      status: 'failed',
      can_retry: false,
      can_dismiss: true,
      error_code: 'model_usage_budget_exceeded',
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

    await waitFor(() => expect(result.current.items).toHaveLength(1));

    expect(result.current.items[0]).toMatchObject({
      status: 'failed',
      can_retry: false,
      description: '图片生成服务的执行结果暂时无法确认；为避免重复生成，本次不会自动重试。',
    });

    unmount();
    client.clear();
  });

  it('keeps a non-limit model-usage image failure distinct from an exhausted quota', () => {
    const item = imageJobNotification({
      job_id: 'image-job-usage-config-1',
      status: 'failed',
      error: '图片生成的计量服务暂不可用，请稍后再试。',
      error_code: 'model_usage_contract_error',
      can_retry: false,
      generation_mode: 'text',
      target_entity_type: 'food',
      bind_status: 'pending',
      created_at: '2026-07-30T00:00:00Z',
      completed_at: '2026-07-30T00:01:00Z',
    });

    expect(item?.description).toBe('图片生成的计量服务暂不可用，请稍后再试。');
    expect(item?.description).not.toContain('额度达到限制');
  });
});
