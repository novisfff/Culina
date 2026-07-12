// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../../api/client';
import type { ActivityLog } from '../../api/types';
import { FamilyActivityModal } from './FamilyActivityViewer';
import type { FamilyActivityQueryState } from './FamilyActivityViewerModel';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.restoreAllMocks();
});

const auditLog: ActivityLog = {
  id: 'activity-1',
  family_id: 'family-1',
  actor_id: 'user-1',
  actor_name: '林然',
  action: 'update',
  entity_type: 'Family',
  entity_id: 'family-1',
  summary: '更新家庭信息',
  created_at: '2026-07-12T10:00:00.000Z',
};

function buildQueryState(overrides: Partial<FamilyActivityQueryState> = {}): FamilyActivityQueryState {
  return {
    data: undefined,
    isLoading: false,
    isError: false,
    isFetching: false,
    refetch: vi.fn(),
    ...overrides,
  };
}

async function flushQueries() {
  await act(async () => {
    await Promise.resolve();
    await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
  });
  await act(async () => {
    await Promise.resolve();
    await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
  });
}

function buttonByText(view: ParentNode, label: string) {
  const button = Array.from(view.querySelectorAll('button')).find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  if (!button) throw new Error(`button not found: ${label}`);
  return button as HTMLButtonElement;
}

function renderActivityViewer(previewQuery: FamilyActivityQueryState) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  act(() => {
    root?.render(
      <QueryClientProvider client={client}>
        <FamilyActivityModal
          previewQuery={previewQuery}
          members={[]}
          onClose={vi.fn()}
        />
      </QueryClientProvider>
    );
  });
  return container;
}

describe('FamilyActivityViewer remote states', () => {
  it('shows loading rather than empty before the first viewer response', () => {
    vi.spyOn(api, 'getActivityLogs').mockImplementation(
      () => new Promise<ActivityLog[]>(() => undefined)
    );
    const view = renderActivityViewer(buildQueryState({ isLoading: true, isFetching: true }));
    expect(view.querySelector('[aria-label="家庭活动加载中"]')).not.toBeNull();
    expect(view.textContent).not.toContain('暂无家庭活动');
  });

  it('shows retry on a no-cache error', async () => {
    const request = vi.spyOn(api, 'getActivityLogs').mockRejectedValue(new Error('offline'));
    const view = renderActivityViewer(buildQueryState({ isError: true }));
    await flushQueries();
    act(() => buttonByText(view, '重试活动记录').click());
    await flushQueries();
    expect(request).toHaveBeenCalledTimes(2);
    expect(view.textContent).not.toContain('暂无家庭活动');
  });

  it('keeps cached rows on refresh failure', async () => {
    vi.spyOn(api, 'getActivityLogs').mockRejectedValue(new Error('offline'));
    const view = renderActivityViewer(buildQueryState({
      data: [auditLog], isError: true, isFetching: false,
    }));
    await flushQueries();
    expect(view.textContent).toContain(auditLog.summary);
    expect(buttonByText(view, '刷新失败，重试')).not.toBeNull();
  });
});
