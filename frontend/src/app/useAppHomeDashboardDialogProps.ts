import type { Dispatch, SetStateAction } from 'react';
import type { AppHomeDashboardDialogsProps } from './AppHomeDashboardDialogs';
import type { NoticeState } from '../hooks/useNotice';
import type { MealLog, UpdateMealLogPayload } from '../api/types';
import type { HomeMealEnrichmentOpenRequest } from '../features/home/useHomeDashboardActions';

type Props = AppHomeDashboardDialogsProps;

type Args = Omit<
  Props,
  | 'openHomeMealRecord'
  | 'isUpdatingHomePlanDetail'
  | 'isCompletingHomePlanDetail'
  | 'onHomeMealEnrichmentMealChanged'
  | 'closeHomeMealEnrichment'
  | 'updateMealLog'
  | 'onInvalidMealEnrichmentSave'
  | 'isUpdatingMeal'
  | 'isCreatingFoodPlanItem'
> & {
  setHomeMealEnrichmentRequest: Dispatch<SetStateAction<HomeMealEnrichmentOpenRequest | null>>;
  updateFoodPlanItemPending: boolean;
  deleteFoodPlanItemPending: boolean;
  cookRecipePending: boolean;
  completeFoodPlanItemPending: boolean;
  updateMealPending: boolean;
  createFoodPlanItemPending: boolean;
  saveHomeMealEnrichment: (meal: MealLog, payload: UpdateMealLogPayload) => Promise<unknown>;
  showNotice: (notice: NoticeState) => void;
};

/** Owns the cross-domain prop adapter for home dashboard dialogs. */
export function useAppHomeDashboardDialogProps(args: Args): Props {
  return {
    ...args,
    isUpdatingHomePlanDetail: args.updateFoodPlanItemPending || args.deleteFoodPlanItemPending,
    isCompletingHomePlanDetail: args.cookRecipePending || args.completeFoodPlanItemPending,
    openHomeMealRecord: (item) => {
      args.closeHomePlanDetail();
      args.setHomeMealEnrichmentRequest({ mealLogId: item.meal_log_id ?? undefined, planItem: item });
    },
    onHomeMealEnrichmentMealChanged: (meal) => args.setHomeMealEnrichmentRequest((current) => ({
      mealLog: meal,
      planItem: current?.planItem,
    })),
    closeHomeMealEnrichment: () => args.setHomeMealEnrichmentRequest(null),
    updateMealLog: (mealLogId, payload) =>
      args.saveHomeMealEnrichment(args.homeMealEnrichmentMeal ?? ({ id: mealLogId } as MealLog), payload),
    onInvalidMealEnrichmentSave: () => args.showNotice({
      tone: 'warning',
      title: '还没有补充内容',
      message: '请先填写评分、家人、备注或照片，再保存这顿饭。',
    }),
    isUpdatingMeal: args.updateMealPending,
    isCreatingFoodPlanItem: args.createFoodPlanItemPending,
  };
}
