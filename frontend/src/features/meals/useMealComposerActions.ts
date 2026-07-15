import { useCallback } from 'react';
import type {
  MealLogCandidate,
  RecordMealPayload,
  RecordMealResponse,
} from '../../api/types';
import {
  MealComposerValidationError,
  buildRecordMealPayload,
} from './MealComposerModel';
import {
  extractMealRecordErrorCode,
  messageFromMealRecordReason,
  resolveRefetchedCandidates,
} from './mealRecordErrors';
import type { MealComposerState } from './useMealComposerState';

export type UseMealComposerActionsArgs = {
  state: MealComposerState;
  candidates: MealLogCandidate[];
  refetchCandidates: () => Promise<{ data?: MealLogCandidate[] | undefined } | unknown>;
  recordMeal: (payload: RecordMealPayload) => Promise<RecordMealResponse>;
  invalidateAfterRecord: (options?: { createdFood?: boolean }) => Promise<void>;
  publishRecordResult: (response: RecordMealResponse) => void;
};

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
      const code = extractMealRecordErrorCode(reason);
      if (code === 'meal_log_stale') {
        const refreshed = await resolveRefetchedCandidates(refetchCandidates);
        state.markTargetStaleAndRefresh(refreshed);
        return;
      }
      state.setError(messageFromMealRecordReason(reason, '记录失败，请重试'));
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
