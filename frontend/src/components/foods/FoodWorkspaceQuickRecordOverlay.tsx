import type { Dispatch, SetStateAction } from 'react';
import type { MealType, RecordMealTarget } from '../../api/types';
import { getFoodCoverAsset } from '../../lib/ui';
import { MealQuickRecordView, type MealQuickRecordViewProps } from '../../features/meals/MealQuickRecordView';
import { canSubmitWithCandidateResolution } from '../../features/meals/MealComposerModel';
import type { FoodQuickRecordState } from './FoodQuickRecordState';

type Props = {
  record: FoodQuickRecordState | null;
  recipes: Parameters<typeof getFoodCoverAsset>[1];
  dateOptions: string[];
  isRecording?: boolean;
  setRecord: Dispatch<SetStateAction<FoodQuickRecordState | null>>;
  onSubmit: () => void;
};

export function FoodWorkspaceQuickRecordOverlay(props: Props) {
  const record = props.record;
  if (!record) return null;
  const update = (patch: Partial<FoodQuickRecordState>) => props.setRecord((current) => current ? { ...current, ...patch } : current);
  const viewProps: MealQuickRecordViewProps = {
    open: true,
    prefilledFood: {
      food_id: record.food.id,
      name: record.food.name,
      cover: getFoodCoverAsset(record.food, props.recipes) ?? null,
      servings: 1,
    },
    date: record.date,
    mealType: record.mealType,
    dateOptions: props.dateOptions,
    candidates: record.candidates,
    selectedCandidateId: record.selectedCandidateId,
    candidateMode: record.candidateMode,
    target: record.target,
    busy: record.busy || Boolean(props.isRecording),
    submitDisabled: !canSubmitWithCandidateResolution(record.candidateResolution),
    error: record.error,
    overlayRootClassName: 'food-workspace-overlay-root',
    onClose: () => { if (!record.busy) props.setRecord(null); },
    onDateChange: (date) => update({ date, target: { kind: 'new' }, selectedCandidateId: null, candidateMode: 'none', candidates: [], candidateResolution: { status: 'loading' }, targetTouchedByUser: false, error: null }),
    onMealTypeChange: (mealType: MealType) => update({ mealType, target: { kind: 'new' }, selectedCandidateId: null, candidateMode: 'none', candidates: [], candidateResolution: { status: 'loading' }, targetTouchedByUser: false, error: null }),
    onTargetChange: (target: RecordMealTarget, selectedCandidateId) => update({ target, selectedCandidateId: selectedCandidateId ?? (target.kind === 'existing' ? target.meal_log_id : null), targetTouchedByUser: true, error: null }),
    onSubmit: props.onSubmit,
  };
  return <MealQuickRecordView {...viewProps} />;
}
