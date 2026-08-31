import { useEffect, type Dispatch, type SetStateAction } from 'react';
import type { MealLogCandidate, RecordMealPayload, RecordMealResponse, Recipe } from '../../api/types';
import { getFoodCoverAsset } from '../../lib/ui';
import {
  buildRecordMealPayload,
  canSubmitWithCandidateResolution,
  deriveCandidatePresentation,
} from '../../features/meals/MealComposerModel';
import { extractMealRecordErrorCode, messageFromMealRecordReason } from '../../features/meals/mealRecordErrors';
import type {
  FoodQuickRecordState,
  FoodStockInventoryFollowUpState,
} from './useIngredientFoodStockState';
import { createClientRequestId } from './ingredientWorkspaceHelpers';

type Args = {
  quickRecord: FoodQuickRecordState | null;
  setQuickRecord: Dispatch<SetStateAction<FoodQuickRecordState | null>>;
  setInventoryFollowUp: Dispatch<SetStateAction<FoodStockInventoryFollowUpState | null>>;
  loadMealCandidates?: (date: string, mealType: FoodQuickRecordState['mealType']) => Promise<MealLogCandidate[]>;
  recordMeal?: (payload: RecordMealPayload) => Promise<RecordMealResponse>;
  recipes: Recipe[];
  onRecordSuccess?: (response: RecordMealResponse) => void;
};

export function useIngredientFoodStockMealRecord(args: Args) {
  useEffect(() => {
    if (!args.quickRecord) return;
    let cancelled = false;
    const { date, mealType } = args.quickRecord;
    const loader = args.loadMealCandidates;
    if (!loader) {
      args.setQuickRecord((current) =>
        current && current.date === date && current.mealType === mealType
          ? { ...current, candidates: [], candidateMode: 'none', candidateResolution: { status: 'ready' } }
          : current,
      );
      return;
    }
    args.setQuickRecord((current) =>
      current && current.date === date && current.mealType === mealType
        ? { ...current, candidateResolution: { status: 'loading' }, error: null }
        : current,
    );
    void (async () => {
      try {
        const candidates = await loader(date, mealType);
        if (cancelled) return;
        const presentation = deriveCandidatePresentation(candidates, mealType);
        args.setQuickRecord((current) => {
          if (!current || current.date !== date || current.mealType !== mealType) return current;
          return {
            ...current,
            candidates,
            candidateMode: presentation.mode,
            candidateResolution: { status: 'ready' },
            ...(current.targetTouchedByUser
              ? {}
              : { target: presentation.target, selectedCandidateId: presentation.selectedCandidateId }),
          };
        });
      } catch (reason) {
        if (cancelled) return;
        const message = reason instanceof Error && reason.message.trim() ? reason.message : '暂时无法加载可选餐食，请重试';
        args.setQuickRecord((current) =>
          current && current.date === date && current.mealType === mealType
            ? { ...current, candidateResolution: { status: 'error', message }, error: message }
            : current,
        );
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [args.quickRecord?.food.id, args.quickRecord?.date, args.quickRecord?.mealType, args.loadMealCandidates]);

  async function submitCompactFoodRecord() {
    const current = args.quickRecord;
    if (!current || current.busy) return;
    if (!args.recordMeal) {
      args.setQuickRecord((state) => (state ? { ...state, error: '记录功能暂不可用，请稍后再试。' } : state));
      return;
    }
    if (!canSubmitWithCandidateResolution(current.candidateResolution)) {
      args.setQuickRecord((state) =>
        state
          ? {
              ...state,
              error:
                state.candidateResolution.status === 'error'
                  ? state.candidateResolution.message || '暂时无法加载可选餐食，请重试'
                  : '正在查找可加入的餐食…',
            }
          : state,
      );
      return;
    }
    let payload: RecordMealPayload;
    try {
      payload = buildRecordMealPayload({
        clientRequestId: current.clientRequestId,
        date: current.date,
        mealType: current.mealType,
        target: current.target,
        foods: [{
          kind: 'existing',
          food_id: current.food.id,
          name: current.food.name,
          servings: 1,
          cover: getFoodCoverAsset(current.food, args.recipes) ?? null,
        }],
      });
    } catch (reason) {
      args.setQuickRecord((state) =>
        state ? { ...state, error: reason instanceof Error && reason.message.trim() ? reason.message : '餐食记录失败，请重试' } : state,
      );
      return;
    }
    args.setQuickRecord((state) => (state ? { ...state, busy: true, error: null } : state));
    try {
      const response = await args.recordMeal(payload);
      args.setQuickRecord(null);
      args.onRecordSuccess?.(response);
      args.setInventoryFollowUp({
        item: current.item,
        stockQuantity: current.item.quantity && current.item.quantity > 0 ? '1' : '',
        error: null,
      });
    } catch (reason) {
      const code = extractMealRecordErrorCode(reason);
      if ((code === 'meal_log_stale') && args.loadMealCandidates) {
        try {
          const refreshed = await args.loadMealCandidates(current.date, current.mealType);
          const presentation = deriveCandidatePresentation(refreshed, current.mealType);
          args.setQuickRecord((state) => state ? {
            ...state,
            busy: false,
            candidates: refreshed,
            candidateMode: presentation.mode,
            candidateResolution: { status: 'ready' },
            target: presentation.target,
            selectedCandidateId: presentation.selectedCandidateId,
            targetTouchedByUser: false,
            error: '这顿饭刚被家人更新，请重新确认',
          } : state);
          return;
        } catch {
          // Fall through to the normal error state.
        }
      }
      if (code === 'idempotency_key_reused' || code === 'record_operation_reverted') {
        args.setQuickRecord((state) => state ? {
          ...state,
          busy: false,
          clientRequestId: createClientRequestId(),
          error: code === 'record_operation_reverted' ? '上次记录已撤销，请再试一次' : '记录内容已变化，请再试一次',
        } : state);
        return;
      }
      args.setQuickRecord((state) => state ? { ...state, busy: false, error: messageFromMealRecordReason(reason, '餐食记录失败，请重试') } : state);
    }
  }

  return { submitCompactFoodRecord };
}
