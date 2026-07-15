import { useCallback, useMemo, useRef, useState } from 'react';
import type {
  MealLog,
  MealLogRecordOperationSummary,
  MediaAsset,
  RecordMealResponse,
  RevertMealRecordResponse,
  UpdateMealLogPayload,
} from '../../api/types';

export type MealRecordResultSource = 'immediate' | 'restored';

export type MealRecordResultFood = {
  food_id: string;
  name: string;
  food_type?: string;
  cover?: MediaAsset | null;
};

export type MealRecordResult = {
  source: MealRecordResultSource;
  operationId: string;
  mealLogId: string;
  foods: MealRecordResultFood[];
  previewMedia: MediaAsset | null;
  revertibleUntil: string;
  canRevert: boolean;
  mealLog: MealLog | null;
  rowVersion: number | null;
  canRate: boolean;
  /** Entry ids created by this op; used to rate only this-op foods. */
  effectEntryIds?: string[] | null;
  outcome?: RecordMealResponse['outcome'] | null;
};

export type UseMealRecordResultStateArgs = {
  activeOperations: MealLogRecordOperationSummary[];
  revertOperation: (operationId: string) => Promise<RevertMealRecordResponse>;
  rateMeal?: (mealLogId: string, payload: UpdateMealLogPayload) => Promise<MealLog>;
  onViewMeal?: (mealLogId: string) => void;
};

function effectEntryIdsFromResponse(response: RecordMealResponse): string[] | null {
  const ids = response.operation.created_entry_ids;
  if (!Array.isArray(ids) || ids.length === 0) return null;
  return ids.map(String).filter((id) => id.trim());
}

function foodsFromMealLog(
  mealLog: MealLog,
  effectEntryIds?: string[] | null,
  createdFoods: RecordMealResponse['created_foods'] = [],
): MealRecordResultFood[] {
  const entries =
    effectEntryIds && effectEntryIds.length > 0
      ? mealLog.food_entries.filter((entry) => effectEntryIds.includes(entry.id))
      : mealLog.food_entries;
  const createdById = new Map(createdFoods.map((food) => [food.id, food]));
  return entries.map((entry) => {
    const created = createdById.get(entry.food_id);
    return {
      food_id: entry.food_id,
      name: entry.food_name,
      food_type: created?.type,
      cover: created?.images?.[0] ?? null,
    };
  });
}

function foodsFromSummary(summary: MealLogRecordOperationSummary): MealRecordResultFood[] {
  return summary.foods.map((food) => ({
    food_id: food.food_id,
    name: food.name,
    food_type: food.food_type,
    cover: food.cover ?? null,
  }));
}

function previewFromResponse(
  response: RecordMealResponse,
  foods: MealRecordResultFood[],
): MediaAsset | null {
  // Prefer meal photos; fall back to this-op Food covers (minor improvement).
  return response.meal_log.photos[0] ?? foods.find((food) => food.cover)?.cover ?? null;
}

function resultFromResponse(response: RecordMealResponse): MealRecordResult {
  const effectEntryIds = effectEntryIdsFromResponse(response);
  const foods = foodsFromMealLog(response.meal_log, effectEntryIds, response.created_foods ?? []);
  // Rate only when we can scope to this-op entries. Appended without effect ids must not rate whole meal.
  const canRate =
    response.outcome === 'created' ||
    (response.outcome === 'appended' && Boolean(effectEntryIds?.length));
  return {
    source: 'immediate',
    operationId: response.operation.id,
    mealLogId: response.meal_log.id,
    foods,
    previewMedia: previewFromResponse(response, foods),
    revertibleUntil: response.operation.revertible_until,
    canRevert: response.operation.can_revert,
    mealLog: response.meal_log,
    rowVersion: response.meal_log.row_version,
    canRate,
    effectEntryIds,
    outcome: response.outcome,
  };
}

function resultFromSummary(summary: MealLogRecordOperationSummary): MealRecordResult {
  return {
    source: 'restored',
    operationId: summary.id,
    mealLogId: summary.meal_log_id,
    foods: foodsFromSummary(summary),
    previewMedia: summary.preview_media ?? null,
    revertibleUntil: summary.revertible_until,
    canRevert: summary.can_revert,
    mealLog: null,
    rowVersion: null,
    canRate: false,
    effectEntryIds: null,
    outcome: null,
  };
}

function pickNewestActive(
  operations: MealLogRecordOperationSummary[],
): MealLogRecordOperationSummary | null {
  if (operations.length === 0) return null;
  return [...operations].sort((left, right) =>
    right.revertible_until.localeCompare(left.revertible_until),
  )[0] ?? null;
}

function messageFromReason(reason: unknown, fallback: string): string {
  if (reason instanceof Error && reason.message.trim()) {
    return reason.message;
  }
  return fallback;
}

/**
 * App-level ordinary record result state.
 * Recipe cook / plan completion / AI approval have no publish API here.
 */
export function useMealRecordResultState(args: UseMealRecordResultStateArgs) {
  const [immediate, setImmediate] = useState<MealRecordResult | null>(null);
  const [dismissedOperationIds, setDismissedOperationIds] = useState<string[]>([]);
  const [isReverting, setIsReverting] = useState(false);
  const [revertError, setRevertError] = useState<string | null>(null);
  const [rateError, setRateError] = useState<string | null>(null);
  const immediateOperationIdRef = useRef<string | null>(null);

  const restored = useMemo(() => {
    const eligible = args.activeOperations.filter(
      (operation) => !dismissedOperationIds.includes(operation.id),
    );
    const newest = pickNewestActive(eligible);
    return newest ? resultFromSummary(newest) : null;
  }, [args.activeOperations, dismissedOperationIds]);

  // Prefer the just-returned full result; otherwise restore newest active summary.
  const result = useMemo(() => {
    if (immediate && !dismissedOperationIds.includes(immediate.operationId)) {
      return immediate;
    }
    return restored;
  }, [dismissedOperationIds, immediate, restored]);

  const publishRecordResult = useCallback((response: RecordMealResponse) => {
    const next = resultFromResponse(response);
    immediateOperationIdRef.current = next.operationId;
    setImmediate(next);
    setDismissedOperationIds((current) => current.filter((id) => id !== next.operationId));
    setRevertError(null);
    setRateError(null);
  }, []);

  const dismiss = useCallback(() => {
    const operationId = immediateOperationIdRef.current ?? result?.operationId ?? null;
    if (operationId) {
      setDismissedOperationIds((current) =>
        current.includes(operationId) ? current : [...current, operationId],
      );
    }
    setImmediate(null);
    immediateOperationIdRef.current = null;
    setRevertError(null);
    setRateError(null);
  }, [result?.operationId]);

  const revert = useCallback(async () => {
    if (!result || isReverting) return;
    const operationId = result.operationId;
    setIsReverting(true);
    setRevertError(null);
    try {
      // Non-optimistic: keep the result/timeline until server 200.
      await args.revertOperation(operationId);
      setImmediate(null);
      immediateOperationIdRef.current = null;
      setDismissedOperationIds((current) =>
        current.includes(operationId) ? current : [...current, operationId],
      );
      setRevertError(null);
    } catch (reason) {
      setRevertError(messageFromReason(reason, '撤销失败，请重试'));
    } finally {
      setIsReverting(false);
    }
  }, [args, isReverting, result]);

  const viewMeal = useCallback(() => {
    if (!result) return;
    args.onViewMeal?.(result.mealLogId);
  }, [args, result]);

  const rate = useCallback(
    async (rating: number | null | undefined) => {
      if (rating == null || Number.isNaN(rating)) {
        // Leaving rating blank creates no state.
        return;
      }
      if (!result?.canRate || !result.mealLog || result.rowVersion == null) {
        return;
      }
      if (!args.rateMeal) return;

      const mealLog = result.mealLog;
      // Rate only this-operation entries when scoped; never overwrite whole-meal entries.
      const rateableEntries =
        result.effectEntryIds && result.effectEntryIds.length > 0
          ? mealLog.food_entries.filter((entry) => result.effectEntryIds!.includes(entry.id))
          : mealLog.food_entries;
      if (rateableEntries.length === 0) {
        return;
      }

      setRateError(null);
      try {
        const updated = await args.rateMeal(mealLog.id, {
          expected_row_version: result.rowVersion,
          food_entry_ratings: rateableEntries.map((entry) => ({
            id: entry.id,
            rating,
          })),
        });
        setImmediate((current) =>
          current && current.operationId === result.operationId
            ? {
                ...current,
                mealLog: updated,
                rowVersion: updated.row_version,
                foods: foodsFromMealLog(updated, current.effectEntryIds),
              }
            : current,
        );
      } catch (reason) {
        setRateError(messageFromReason(reason, '评分失败，请重试'));
      }
    },
    [args, result],
  );

  return {
    result,
    isReverting,
    revertError,
    rateError,
    publishRecordResult,
    dismiss,
    revert,
    viewMeal,
    rate,
  };
}
