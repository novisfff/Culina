import { useEffect, useState, type FormEvent } from 'react';
import type { Food, FoodPlanItem, MealLogCandidate, Recipe, RecordMealTarget } from '../../api/types';
import { MealCandidateSelector } from '../../features/meals/MealCandidateSelector';
import {
  deriveCandidatePresentation,
  type MealComposerFood,
} from '../../features/meals/MealComposerModel';
import { useMealCandidateData } from '../../features/meals/useMealCandidateData';
import { FoodPlanDetailModal, type FoodPlanDetailFormState } from './FoodPlanDetailModal';

export type FoodPlanDetailWithCandidatesProps = {
  item: FoodPlanItem;
  food: Food | null;
  recipes: Recipe[];
  form: FoodPlanDetailFormState;
  isEditing: boolean;
  isUpdatingPlan?: boolean;
  isCompleting?: boolean;
  onClose: () => void;
  onChangeForm: (form: FoodPlanDetailFormState) => void;
  onEditingChange: (editing: boolean) => void;
  onResetEdit: () => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onComplete: (target?: {
    target_meal_log_id?: string | null;
    expected_meal_log_row_version?: number | null;
  }) => void;
  onDelete: () => void;
  resolveAssetUrl: (url: string) => string;
};

/** Plan detail with candidate confirmation for non-Recipe complete (Task 15). */
export function FoodPlanDetailWithCandidates(props: FoodPlanDetailWithCandidatesProps) {
  const needsPlanCompleteCandidates = Boolean(
    props.item && !props.item.recipe_id && props.item.status !== 'cooked',
  );
  const planCandidateQuery = useMealCandidateData({
    open: needsPlanCompleteCandidates,
    date: props.item.plan_date,
    mealType: props.item.meal_type,
  });
  const planCandidates = planCandidateQuery.candidates;
  const planCandidatesFetched = planCandidateQuery.query.isFetched;
  const planCandidateIdsKey = planCandidates
    .map((candidate) => `${candidate.meal_log_id}:${candidate.row_version}`)
    .join(',');
  const [planCompleteTarget, setPlanCompleteTarget] = useState<RecordMealTarget>({ kind: 'new' });
  const [planCompleteSelectedCandidateId, setPlanCompleteSelectedCandidateId] = useState<string | null>(null);
  const [planCompleteCandidateMode, setPlanCompleteCandidateMode] = useState<'none' | 'single' | 'multi'>('none');

  useEffect(() => {
    if (!needsPlanCompleteCandidates) {
      setPlanCompleteTarget((current) => (current.kind === 'new' ? current : { kind: 'new' }));
      setPlanCompleteSelectedCandidateId(null);
      setPlanCompleteCandidateMode('none');
      return;
    }
    if (!planCandidatesFetched) return;
    const presentation = deriveCandidatePresentation(planCandidates, props.item.meal_type);
    setPlanCompleteTarget(presentation.target);
    setPlanCompleteSelectedCandidateId(presentation.selectedCandidateId);
    setPlanCompleteCandidateMode(presentation.mode);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [needsPlanCompleteCandidates, props.item.id, props.item.plan_date, props.item.meal_type, planCandidateIdsKey, planCandidatesFetched]);

  const planCompleteDraftFoods: MealComposerFood[] = [{
    kind: 'existing', food_id: props.item.food_id, name: props.item.food_name, servings: 1, cover: null,
  }];
  const planCompleteExtras = needsPlanCompleteCandidates ? (
    <MealCandidateSelector
      mode={planCompleteCandidateMode}
      mealType={props.item.meal_type}
      candidates={planCandidates}
      selectedCandidateId={planCompleteSelectedCandidateId}
      target={planCompleteTarget}
      draftFoods={planCompleteDraftFoods}
      disabled={props.isCompleting}
      className="food-plan-detail-candidates"
      onTargetChange={(target, selectedCandidateId) => {
        setPlanCompleteTarget(target);
        setPlanCompleteSelectedCandidateId(selectedCandidateId ?? null);
      }}
    />
  ) : null;

  function handleComplete() {
    if (props.item.recipe_id) {
      props.onComplete();
      return;
    }
    const target = planCompleteTarget.kind === 'existing'
      ? { target_meal_log_id: planCompleteTarget.meal_log_id, expected_meal_log_row_version: planCompleteTarget.expected_row_version }
      : undefined;
    props.onComplete(target);
  }

  return (
    <FoodPlanDetailModal
      item={props.item}
      food={props.food}
      recipes={props.recipes}
      form={props.form}
      isEditing={props.isEditing}
      isUpdatingPlan={props.isUpdatingPlan}
      isCompleting={props.isCompleting}
      completeExtras={planCompleteExtras}
      onClose={props.onClose}
      onChangeForm={props.onChangeForm}
      onEditingChange={props.onEditingChange}
      onResetEdit={props.onResetEdit}
      onSubmit={props.onSubmit}
      onComplete={handleComplete}
      onDelete={props.onDelete}
      resolveAssetUrl={props.resolveAssetUrl}
      overlayRootClassName="food-workspace-overlay-root"
    />
  );
}
