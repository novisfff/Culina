import type { buildEatTaskBodies } from '../features/eat/EatTaskBodies';

type BodyArgs = Omit<Parameters<typeof buildEatTaskBodies>[0], 'resolvedTask'>;

type DataPort = Pick<BodyArgs, 'recipes' | 'foods' | 'ingredients' | 'inventoryItems' | 'mealLogs' | 'foodPlanItems' | 'members' | 'sessionScope'>;
type PendingPort = Pick<BodyArgs, 'isRecordingMeal' | 'isCompletingPlan' | 'isUpdatingPlan' | 'isCookingRecipe' | 'isCreatingShopping' | 'isSavingFood' | 'isUpdatingRecipe' | 'isUpdatingMeal'>;
type ActionPort = Pick<BodyArgs, 'cookRecipe' | 'previewCookRecipe' | 'updateFoodPlanItem' | 'deleteFoodPlanItem' | 'createFoodPlanItem' | 'updateFood' | 'updateRecipe' | 'updateMealLog' | 'createShoppingItem' | 'recordMeal' | 'completeFoodPlanItem' | 'onRecordSuccess' | 'onClose' | 'onOpenLogs' | 'onNavigateRecipe' | 'onStartCook' | 'onStartCookWithFood' | 'onQuickAdd' | 'onCookCompleted' | 'onViewMealLog' | 'onCookResumePromptChange'>;

type Args = {
  data: DataPort;
  pending: PendingPort;
  actions: ActionPort;
};

/** Builds the typed adapter passed to Eat's task-body renderer. */
export function useAppEatTaskBodyArgs(args: Args): BodyArgs {
  return { ...args.data, ...args.pending, ...args.actions };
}
