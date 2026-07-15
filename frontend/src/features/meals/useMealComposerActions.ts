import { useCallback } from 'react';
import { isApiError } from '../../api/request';
import type {
  MealLogCandidate,
  RecordMealPayload,
  RecordMealResponse,
} from '../../api/types';
import {
  MealComposerValidationError,
  buildRecordMealPayload,
} from './MealComposerModel';
import type { MealComposerState } from './useMealComposerState';

export type UseMealComposerActionsArgs = {
  state: MealComposerState;
  candidates: MealLogCandidate[];
  refetchCandidates: () => Promise<{ data?: MealLogCandidate[] | undefined } | unknown>;
  recordMeal: (payload: RecordMealPayload) => Promise<RecordMealResponse>;
  invalidateAfterRecord: (options?: { createdFood?: boolean }) => Promise<void>;
  publishRecordResult: (response: RecordMealResponse) => void;
};

function extractErrorCode(reason: unknown): string | null {
  if (!isApiError(reason)) return null;
  const payload = reason.payload;
  if (!payload || typeof payload !== 'object' || !('detail' in payload)) return null;
  const detail = (payload as { detail?: unknown }).detail;
  if (detail && typeof detail === 'object' && !Array.isArray(detail) && 'code' in detail) {
    const code = (detail as { code?: unknown }).code;
    return typeof code === 'string' ? code : null;
  }
  return null;
}

function messageFromReason(reason: unknown, fallback: string): string {
  if (isApiError(reason)) {
    const payload = reason.payload;
    if (payload && typeof payload === 'object' && 'detail' in payload) {
      const detail = (payload as { detail?: unknown }).detail;
      if (detail && typeof detail === 'object' && !Array.isArray(detail)) {
        const message = (detail as { message?: unknown }).message;
        if (typeof message === 'string' && message.trim()) {
          return message;
        }
      }
      if (typeof detail === 'string' && detail.trim()) {
        return detail;
      }
    }
    if (reason.detail && reason.detail !== '[object Object]') {
      return reason.detail;
    }
    return fallback;
  }
  if (reason instanceof Error && reason.message.trim()) {
    return reason.message;
  }
  return fallback;
}

async function resolveRefetchedCandidates(
  refetch: UseMealComposerActionsArgs['refetchCandidates'],
): Promise<MealLogCandidate[]> {
  const result = await refetch();
  if (result && typeof result === 'object' && 'data' in result) {
    const data = (result as { data?: MealLogCandidate[] | undefined }).data;
    return Array.isArray(data) ? data : [];
  }
  return [];
}

export function useMealComposerActions(args: UseMealComposerActionsArgs) {
  const { state, recordMeal, invalidateAfterRecord, publishRecordResult, refetchCandidates } = args;

  const submitRecord = useCallback(async () => {
    if (state.busy) return;

    let payload: RecordMealPayload;
    try {
      payload = buildRecordMealPayload({
        clientRequestId: state.recordClientRequestId,
        date: state.date,
        mealType: state.mealType,
        target: state.target,
        foods: state.foods,
      });
    } catch (reason) {
      if (reason instanceof MealComposerValidationError) {
        state.setError(reason.issues[0]?.message ?? reason.message);
        return;
      }
      throw reason;
    }

    state.setBusy(true);
    state.setError(null);
    try {
      const response = await recordMeal(payload);
      await invalidateAfterRecord({
        createdFood: (response.created_foods?.length ?? 0) > 0,
      });
      // Close before publishing so the current surface shows the result bar, not the open composer.
      state.close();
      publishRecordResult(response);
    } catch (reason) {
      const code = extractErrorCode(reason);
      if (code === 'meal_log_stale') {
        const refreshed = await resolveRefetchedCandidates(refetchCandidates);
        state.markTargetStaleAndRefresh(refreshed);
        return;
      }
      state.setError(messageFromReason(reason, '记录失败，请重试'));
    } finally {
      state.setBusy(false);
    }
  }, [
    invalidateAfterRecord,
    publishRecordResult,
    recordMeal,
    refetchCandidates,
    state,
  ]);

  return {
    submitRecord,
  };
}
