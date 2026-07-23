// @vitest-environment jsdom

import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { aiApi } from '../api/aiApi';
import type {
  AiRunCancellationPhase,
  AiRunCancellationResponse,
} from '../api/types';
import { ApiError } from '../api/request';
import { useAiRunCancellation } from './useAiRunCancellation';

type ProbeValue = {
  cancelRun: (runId: string, controller: AbortController) => Promise<AiRunCancellationResponse>;
  getCancellationState: (runId: string) => { phase: AiRunCancellationPhase; error: string };
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function cancellationResponse(
  runId: string,
  outcome: AiRunCancellationResponse['outcome'],
): AiRunCancellationResponse {
  const cancelled = outcome !== 'cancel_requested';
  return {
    outcome,
    request: {
      run_id: runId,
      status: cancelled ? 'applied' : 'requested',
      requested_at: '2026-07-23T00:00:00Z',
      resolved_at: cancelled ? '2026-07-23T00:00:01Z' : null,
    },
    run: {
      id: runId,
      agent_key: 'workspace_orchestrator',
      intent: 'workspace_orchestrator',
      status: cancelled ? 'cancelled' : 'cancelling',
      model: 'fake',
      created_at: '2026-07-23T00:00:00Z',
    },
    events: [],
  };
}

describe('useAiRunCancellation', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('deduplicates rapid stop clicks for one run', async () => {
    const pending = deferred<AiRunCancellationResponse>();
    const post = vi.spyOn(aiApi, 'cancelAiRun').mockReturnValue(pending.promise);
    const controller = new AbortController();
    const { result } = renderHook(() => useAiRunCancellation({})) as { result: { current: ProbeValue } };

    let first!: Promise<AiRunCancellationResponse>;
    let second!: Promise<AiRunCancellationResponse>;
    act(() => {
      first = result.current.cancelRun('run-1', controller);
      second = result.current.cancelRun('run-1', controller);
    });

    expect(first).toBe(second);
    expect(post).toHaveBeenCalledTimes(1);
    expect(result.current.getCancellationState('run-1').phase).toBe('requesting');

    await act(async () => {
      pending.resolve(cancellationResponse('run-1', 'cancelled'));
      await first;
    });
    expect(controller.signal.aborted).toBe(true);
    expect(result.current.getCancellationState('run-1').phase).toBe('cancelled');
  });

  it.each([404, 409, 500])('keeps the stream alive when cancel returns %s', async (status) => {
    const onConflict = vi.fn();
    vi.spyOn(aiApi, 'cancelAiRun').mockRejectedValue(new ApiError({
      status,
      detail: `取消失败 ${status}`,
      path: '/api/ai/runs/run-1/cancel',
      payload: {},
    }));
    const controller = new AbortController();
    const { result } = renderHook(() => useAiRunCancellation({ onConflict }));

    await act(async () => {
      await expect(result.current.cancelRun('run-1', controller)).rejects.toThrow(`取消失败 ${status}`);
    });

    expect(controller.signal.aborted).toBe(false);
    expect(result.current.getCancellationState('run-1')).toMatchObject({
      phase: 'failed',
      error: `取消失败 ${status}`,
    });
    expect(onConflict).toHaveBeenCalledTimes(status === 409 ? 1 : 0);
  });

  it('shows cancelling for 202 and waits for backend cancelled status', async () => {
    vi.useFakeTimers();
    const post = deferred<AiRunCancellationResponse>();
    vi.spyOn(aiApi, 'cancelAiRun').mockReturnValue(post.promise);
    const get = vi.spyOn(aiApi, 'getAiRunCancellation')
      .mockResolvedValue(cancellationResponse('run-1', 'cancelled'));
    const onConfirmed = vi.fn();
    const controller = new AbortController();
    const { result } = renderHook(() => useAiRunCancellation({ pollIntervalMs: 25, onConfirmed }));

    let cancellation!: Promise<AiRunCancellationResponse>;
    act(() => {
      cancellation = result.current.cancelRun('run-1', controller);
    });
    expect(result.current.getCancellationState('run-1').phase).toBe('requesting');

    await act(async () => {
      post.resolve(cancellationResponse('run-1', 'cancel_requested'));
      await Promise.resolve();
    });
    expect(controller.signal.aborted).toBe(true);
    expect(result.current.getCancellationState('run-1').phase).toBe('cancelling');
    expect(onConfirmed).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(25);
      await cancellation;
    });
    expect(get).toHaveBeenCalledTimes(1);
    expect(result.current.getCancellationState('run-1').phase).toBe('cancelled');
    expect(onConfirmed).toHaveBeenCalledWith(
      'run-1',
      expect.objectContaining({ outcome: 'cancelled' }),
    );
  });

  it('keeps cancellation state isolated between two runs', async () => {
    const runA = deferred<AiRunCancellationResponse>();
    const runB = deferred<AiRunCancellationResponse>();
    vi.spyOn(aiApi, 'cancelAiRun').mockImplementation((runId) => (
      runId === 'run-a' ? runA.promise : runB.promise
    ));
    const { result } = renderHook(() => useAiRunCancellation({}));
    let promiseA!: Promise<AiRunCancellationResponse>;
    let promiseB!: Promise<AiRunCancellationResponse>;

    act(() => {
      promiseA = result.current.cancelRun('run-a', new AbortController());
      promiseB = result.current.cancelRun('run-b', new AbortController());
    });
    expect(result.current.getCancellationState('run-a').phase).toBe('requesting');
    expect(result.current.getCancellationState('run-b').phase).toBe('requesting');

    await act(async () => {
      runA.resolve(cancellationResponse('run-a', 'cancelled'));
      await promiseA;
    });
    expect(result.current.getCancellationState('run-a').phase).toBe('cancelled');
    expect(result.current.getCancellationState('run-b').phase).toBe('requesting');

    await act(async () => {
      runB.resolve(cancellationResponse('run-b', 'cancelled'));
      await promiseB;
    });
  });
});
