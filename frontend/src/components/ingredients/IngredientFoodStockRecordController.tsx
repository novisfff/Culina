import type { FormEvent } from 'react';
import type { Recipe } from '../../api/types';
import { canSubmitWithCandidateResolution } from '../../features/meals/MealComposerModel';
import { MealQuickRecordView } from '../../features/meals/MealQuickRecordView';
import { MealRecordResultBar } from '../../features/meals/MealRecordResultBar';
import type { MealRecordResult } from '../../features/meals/useMealRecordResultState';
import { getFoodCoverAsset } from '../../lib/ui';
import { IngredientFoodStockDialogs } from './IngredientFoodStockDialogs';
import type { useIngredientFoodStockState } from './useIngredientFoodStockState';

type IngredientFoodStockRecordControllerProps = {
  recipes: Recipe[];
  todayDate: string;
  dateOptions: string[];
  state: ReturnType<typeof useIngredientFoodStockState>;
  recordResult?: MealRecordResult | null;
  isRevertingRecord?: boolean;
  recordRevertError?: string | null;
  recordRateError?: string | null;
  onRevertRecord?: () => void | Promise<void>;
  onViewRecord?: () => void;
  onRateRecord?: (rating: number | null | undefined) => void | Promise<void>;
  onDismissRecord?: () => void;
  isRecordingMeal?: boolean;
  submitCompactFoodRecord: () => void | Promise<void>;
  submitInventoryFollowUp: (event: FormEvent<HTMLFormElement>) => void;
  submitFoodStockDeductDialog: (event: FormEvent<HTMLFormElement>) => void;
  submitFoodStockAdjustDialog: (event: FormEvent<HTMLFormElement>) => void;
};

export function IngredientFoodStockRecordController(props: IngredientFoodStockRecordControllerProps) {
  const {
    quickRecord,
    setQuickRecord,
    inventoryFollowUp,
    setInventoryFollowUp,
    foodStockDeductDialog,
    setFoodStockDeductDialog,
    foodStockAdjustDialog,
    setFoodStockAdjustDialog,
    foodStockSubmitting,
    setFoodStockRestockQuantity,
    setFoodStockRestockExpiryDays,
    setFoodStockRestockSource,
  } = props.state;

  return (
    <>
      <MealRecordResultBar
        result={props.recordResult ?? null}
        isReverting={props.isRevertingRecord}
        revertError={props.recordRevertError}
        rateError={props.recordRateError}
        onRevert={props.onRevertRecord}
        onView={props.onViewRecord}
        onRate={props.onRateRecord}
        onDismiss={props.onDismissRecord}
      />

      {quickRecord ? (
        <MealQuickRecordView
          open
          prefilledFood={{
            food_id: quickRecord.food.id,
            name: quickRecord.food.name,
            cover: getFoodCoverAsset(quickRecord.food, props.recipes) ?? null,
            servings: 1,
          }}
          date={quickRecord.date}
          mealType={quickRecord.mealType}
          dateOptions={props.dateOptions}
          candidates={quickRecord.candidates}
          selectedCandidateId={quickRecord.selectedCandidateId}
          candidateMode={quickRecord.candidateMode}
          target={quickRecord.target}
          busy={quickRecord.busy || Boolean(props.isRecordingMeal)}
          submitDisabled={!canSubmitWithCandidateResolution(quickRecord.candidateResolution)}
          error={quickRecord.error}
          overlayRootClassName="ingredient-workspace-overlay-root"
          onClose={() => {
            if (!quickRecord.busy) setQuickRecord(null);
          }}
          onDateChange={(date) => {
            setQuickRecord((current) => current ? {
              ...current,
              date,
              target: { kind: 'new' },
              selectedCandidateId: null,
              candidateMode: 'none',
              candidates: [],
              candidateResolution: { status: 'loading' },
              targetTouchedByUser: false,
              error: null,
            } : current);
          }}
          onMealTypeChange={(mealType) => {
            setQuickRecord((current) => current ? {
              ...current,
              mealType,
              target: { kind: 'new' },
              selectedCandidateId: null,
              candidateMode: 'none',
              candidates: [],
              candidateResolution: { status: 'loading' },
              targetTouchedByUser: false,
              error: null,
            } : current);
          }}
          onTargetChange={(target, selectedCandidateId) => {
            setQuickRecord((current) => current ? {
              ...current,
              target,
              selectedCandidateId: selectedCandidateId ?? (target.kind === 'existing' ? target.meal_log_id : null),
              targetTouchedByUser: true,
              error: null,
            } : current);
          }}
          onSubmit={() => void props.submitCompactFoodRecord()}
        />
      ) : null}

      <IngredientFoodStockDialogs
        todayDate={props.todayDate}
        inventoryFollowUp={inventoryFollowUp}
        foodStockDeductDialog={foodStockDeductDialog}
        foodStockAdjustDialog={foodStockAdjustDialog}
        foodStockSubmitting={foodStockSubmitting}
        setInventoryFollowUp={setInventoryFollowUp}
        setFoodStockDeductDialog={setFoodStockDeductDialog}
        setFoodStockAdjustDialog={setFoodStockAdjustDialog}
        setFoodStockRestockQuantity={setFoodStockRestockQuantity}
        setFoodStockRestockExpiryDays={setFoodStockRestockExpiryDays}
        setFoodStockRestockSource={setFoodStockRestockSource}
        submitInventoryFollowUp={props.submitInventoryFollowUp}
        submitFoodStockDeductDialog={props.submitFoodStockDeductDialog}
        submitFoodStockAdjustDialog={props.submitFoodStockAdjustDialog}
      />
    </>
  );
}
