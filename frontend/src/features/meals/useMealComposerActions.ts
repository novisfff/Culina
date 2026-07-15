import { useCallback } from 'react';
import type {
  MealLogCandidate,
  RecordMealPayload,
  RecordMealResponse,
} from '../../api/types';
import {
  MealComposerValidationError,
  buildRecordMealPayload,
  canSubmitWithCandidateResolution,
  type MealCandidateResolution,
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
  /** Candidate resolution for the current date/mealType; submit blocked until ready. */
  candidateResolution?: MealCandidateResolution;
  refetchCandidates: () => Promise<{ data?: MealLogCandidate[] | undefined } | unknown>;
  recordMeal: (payload: RecordMealPayload) => Promise<RecordMealResponse>;
  invalidateAfterRecord: (options?: { createdFood?: boolean }) => Promise<void>;
  publishRecordResult: (response: RecordMealResponse) => void;
};

export function useMealComposerActions(args: UseMealComposerActionsArgs) {
  const {
    state,
    recordMeal,
    invalidateAfterRecord,
    publishRecordResult,
    refetchCandidates,
    candidateResolution,
  } = args;

  const submitRecord = useCallback(async () => {
    if (state.busy) return;
    if (state.requiresTargetReconfirm) {
      state.setError('这顿饭刚被家人更新，请重新确认目标');
      return;
    }
    if (candidateResolution && !canSubmitWithCandidateResolution(candidateResolution)) {
      if (candidateResolution.status === 'error') {
        state.setError(candidateResolution.message || '加载候选失败，请重试');
      } else {
        state.setError('正在确认是否有可加入的餐食…');
      }
      return;
    }

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
      if (code === 'idempotency_key_reused' || code === 'record_operation_reverted') {
        // Payload changed after a timed-out attempt, or prior op was undone — rotate id and ask user to retry.
        state.rotateClientRequestId();
        state.setError(
          code === 'record_operation_reverted'
            ? '上次记录已撤销，请再试一次'
            : '记录内容已变化，请再试一次',
        );
        return;
      }
      state.setError(messageFromMealRecordReason(reason, '记录失败，请重试'));
    } finally {
      state.setBusy(false);
    }
  }, [
    candidateResolution,
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
