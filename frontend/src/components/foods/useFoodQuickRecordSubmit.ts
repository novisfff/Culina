import type { Dispatch, SetStateAction } from 'react';
import type { RecordMealPayload, RecordMealResponse, Recipe } from '../../api/types';
import { getFoodCoverAsset, formatDate, MEAL_TYPE_LABELS } from '../../lib/ui';
import { buildRecordMealPayload, canSubmitWithCandidateResolution, deriveCandidatePresentation } from '../../features/meals/MealComposerModel';
import { extractMealRecordErrorCode, messageFromMealRecordReason } from '../../features/meals/mealRecordErrors';
import type { FoodQuickRecordState } from './FoodQuickRecordState';
import { createFoodRecordClientRequestId } from './FoodQuickRecordState';

type Args = {
  quickRecord: FoodQuickRecordState | null;
  setQuickRecord: Dispatch<SetStateAction<FoodQuickRecordState | null>>;
  recordMeal: (payload: RecordMealPayload) => Promise<RecordMealResponse>;
  recipes: Recipe[];
  setFeedback: (message: string) => void;
  mealBusinessDate: string;
  loadMealCandidates?: (date: string, mealType: FoodQuickRecordState['mealType']) => Promise<import('../../api/types').MealLogCandidate[]>;
  onRecordSuccess?: (response: RecordMealResponse) => void;
};

export function useFoodQuickRecordSubmit(args: Args) {
  async function submitCompactRecord() {
    const current = args.quickRecord;
    if (!current || current.busy) return;
    if (!canSubmitWithCandidateResolution(current.candidateResolution)) {
      args.setQuickRecord((state) => state ? {
        ...state,
        error: state.candidateResolution.status === 'error'
          ? state.candidateResolution.message || '暂时无法加载可选餐食，请重试'
          : '正在查找可加入的餐食…',
      } : state);
      return;
    }
    let payload: RecordMealPayload;
    try {
      payload = buildRecordMealPayload({
        clientRequestId: current.clientRequestId,
        date: current.date,
        mealType: current.mealType,
        target: current.target,
        foods: [{ kind: 'existing', food_id: current.food.id, name: current.food.name, servings: 1, cover: getFoodCoverAsset(current.food, args.recipes) ?? null }],
      });
    } catch (reason) {
      args.setQuickRecord((state) => state ? { ...state, error: reason instanceof Error && reason.message.trim() ? reason.message : '餐食记录失败，请重试' } : state);
      return;
    }
    args.setQuickRecord((state) => state ? { ...state, busy: true, error: null } : state);
    try {
      const response = await args.recordMeal(payload);
      args.setQuickRecord(null);
      args.onRecordSuccess?.(response);
      args.setFeedback(`${current.food.name} 已记入${current.date === args.mealBusinessDate ? '今天' : formatDate(current.date)}${MEAL_TYPE_LABELS[current.mealType]}`);
    } catch (reason) {
      const code = extractMealRecordErrorCode(reason);
      if (code === 'meal_log_stale' && args.loadMealCandidates) {
        try {
          const refreshed = await args.loadMealCandidates(current.date, current.mealType);
          const presentation = deriveCandidatePresentation(refreshed, current.mealType);
          args.setQuickRecord((state) => state ? { ...state, busy: false, candidates: refreshed, candidateMode: presentation.mode, candidateResolution: { status: 'ready' }, target: presentation.target, selectedCandidateId: presentation.selectedCandidateId, targetTouchedByUser: false, error: '这顿饭刚被家人更新，请重新确认' } : state);
          return;
        } catch { /* fall through */ }
      }
      if (code === 'idempotency_key_reused' || code === 'record_operation_reverted') {
        args.setQuickRecord((state) => state ? { ...state, busy: false, clientRequestId: createFoodRecordClientRequestId(), error: code === 'record_operation_reverted' ? '上次记录已撤销，请再试一次' : '记录内容已变化，请再试一次' } : state);
        return;
      }
      args.setQuickRecord((state) => state ? { ...state, busy: false, error: messageFromMealRecordReason(reason, '餐食记录失败，请重试') } : state);
    }
  }
  return { submitCompactRecord };
}
