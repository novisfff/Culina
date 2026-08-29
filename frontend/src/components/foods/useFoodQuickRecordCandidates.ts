import { useEffect, type Dispatch, type SetStateAction } from 'react';
import type { MealLogCandidate } from '../../api/types/meal';
import { deriveCandidatePresentation } from '../../features/meals/MealComposerModel';
import type { FoodQuickRecordState } from './FoodQuickRecordState';

type Args = {
  quickRecord: FoodQuickRecordState | null;
  setQuickRecord: Dispatch<SetStateAction<FoodQuickRecordState | null>>;
  loadMealCandidates?: (date: string, mealType: FoodQuickRecordState['mealType']) => Promise<MealLogCandidate[]>;
};

export function useFoodQuickRecordCandidates(args: Args) {
  useEffect(() => {
    if (!args.quickRecord) return;
    let cancelled = false;
    const { date, mealType } = args.quickRecord;
    if (!args.loadMealCandidates) {
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
        const candidates = await args.loadMealCandidates!(date, mealType);
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
}
