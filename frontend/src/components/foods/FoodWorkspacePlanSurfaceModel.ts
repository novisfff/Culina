import type { ReactNode, RefObject } from 'react';
import type { FoodPlanItem, MealType } from '../../api/types/food';
import type { FoodPlanSurfaceProps } from './FoodPlanSurface';

export type FoodWorkspacePlanSurfaceArgs = {
  weekRange: FoodPlanSurfaceProps['weekRange'];
  days: FoodPlanSurfaceProps['days'];
  getPlanItemCoverAsset: FoodPlanSurfaceProps['getPlanItemCoverAsset'];
  weekSectionRef: RefObject<HTMLDivElement>;
  isUpdatingPlan?: boolean;
  isStartingPlanItem?: boolean;
  canCreatePlan: boolean;
  mobileWeekPage: ReactNode;
  onPreviousWeek: () => void;
  onCurrentWeek: () => void;
  onNextWeek: () => void;
  onCreatePlan: (defaults?: Partial<{ planDate: string; mealType: MealType }>) => void;
  onOpenPlanItem: (item: FoodPlanItem) => void;
  onStartPlanItem: (item: FoodPlanItem) => void;
};

export function buildFoodWorkspacePlanSurfaceProps(args: FoodWorkspacePlanSurfaceArgs): FoodPlanSurfaceProps {
  return {
    weekRange: args.weekRange,
    days: args.days,
    getPlanItemCoverAsset: args.getPlanItemCoverAsset,
    weekSectionRef: args.weekSectionRef,
    isUpdatingPlan: args.isUpdatingPlan,
    isStartingPlanItem: args.isStartingPlanItem,
    canCreatePlan: args.canCreatePlan,
    mobileWeekPage: args.mobileWeekPage,
    onPreviousWeek: args.onPreviousWeek,
    onCurrentWeek: args.onCurrentWeek,
    onNextWeek: args.onNextWeek,
    onCreatePlan: args.onCreatePlan,
    onOpenPlanItem: args.onOpenPlanItem,
    onStartPlanItem: args.onStartPlanItem,
  };
}
