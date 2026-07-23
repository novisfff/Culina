import { useCallback, useRef, useState } from 'react';
import { aiApi } from '../api/aiApi';
import type {
  AiRunCancellationPhase,
  AiRunCancellationResponse,
} from '../api/types';
import { isApiError } from '../api/request';
import { abortAiStream } from '../lib/aiStreamAbort';

type CancellationState = {
  phase: AiRunCancellationPhase;
  error: string;
  response?: AiRunCancellationResponse;
};

type UseAiRunCancellationOptions = {
  pollIntervalMs?: number;
  onConfirmed?: (runId: string, response: AiRunCancellationResponse) => void;
  onConflict?: (runId: string) => void;
};

const IDLE_CANCELLATION_STATE: CancellationState = {
  phase: 'idle',
  error: '',
};

function cancellationErrorMessage(error: unknown) {
  return error instanceof Error && error.message.trim()
    ? error.message
    : '停止失败，请稍后重试。';
}

function isCancellationConfirmed(response: AiRunCancellationResponse) {
  return response.run?.status === 'cancelled'
    || response.outcome === 'cancelled'
    || response.outcome === 'already_cancelled';
}

function wait(ms: number) {
  return new Promise<void>((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

export function useAiRunCancellation(options: UseAiRunCancellationOptions) {
  const promiseByRunIdRef = useRef<Record<string, Promise<AiRunCancellationResponse>>>({});
  const [stateByRunId, setStateByRunId] = useState<Record<string, CancellationState>>({});

  const updateState = useCallback((runId: string, state: CancellationState) => {
    setStateByRunId((current) => ({ ...current, [runId]: state }));
  }, []);

  const cancelRun = useCallback((
    runId: string,
    controller: AbortController,
  ): Promise<AiRunCancellationResponse> => {
    const existing = promiseByRunIdRef.current[runId];
    if (existing) {
      return existing;
    }

    updateState(runId, { phase: 'requesting', error: '' });
    const cancellation = (async () => {
      try {
        let response = await aiApi.cancelAiRun(runId);
        abortAiStream(controller, { type: 'cancel_accepted', runId });
        if (!isCancellationConfirmed(response)) {
          updateState(runId, { phase: 'cancelling', error: '', response });
          do {
            await wait(options.pollIntervalMs ?? 250);
            response = await aiApi.getAiRunCancellation(runId);
          } while (!isCancellationConfirmed(response));
        }
        updateState(runId, { phase: 'cancelled', error: '', response });
        options.onConfirmed?.(runId, response);
        return response;
      } catch (error) {
        updateState(runId, {
          phase: 'failed',
          error: cancellationErrorMessage(error),
        });
        if (isApiError(error) && error.status === 409) {
          options.onConflict?.(runId);
        }
        throw error;
      }
    })();
    promiseByRunIdRef.current[runId] = cancellation;
    void cancellation.then(
      () => {
        if (promiseByRunIdRef.current[runId] === cancellation) {
          delete promiseByRunIdRef.current[runId];
        }
      },
      () => {
        if (promiseByRunIdRef.current[runId] === cancellation) {
          delete promiseByRunIdRef.current[runId];
        }
      },
    );
    return cancellation;
  }, [options, updateState]);

  const getCancellationState = useCallback(
    (runId: string) => stateByRunId[runId] ?? IDLE_CANCELLATION_STATE,
    [stateByRunId],
  );

  const clearCancellation = useCallback((runId: string) => {
    setStateByRunId((current) => {
      if (!(runId in current)) {
        return current;
      }
      const next = { ...current };
      delete next[runId];
      return next;
    });
  }, []);

  return {
    cancelRun,
    getCancellationState,
    clearCancellation,
  };
}
