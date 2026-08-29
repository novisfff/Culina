import { useIngredientMutations } from './mutations/useIngredientMutations';
import { useInventoryMutations } from './mutations/useInventoryMutations';
import { useShoppingMutations } from './mutations/useShoppingMutations';
import { useRecipeMutations } from './mutations/useRecipeMutations';
import { useFoodPlanMutations } from './mutations/useFoodPlanMutations';
import { useFoodMutations } from './mutations/useFoodMutations';
import { useMealMutations } from './mutations/useMealMutations';

export function useAppMutations() {
  const ingredient = useIngredientMutations();
  const shopping = useShoppingMutations();
  const recipe = useRecipeMutations();
  const food = useFoodMutations();
  const foodPlan = useFoodPlanMutations();
  const meal = useMealMutations();
  const inventory = useInventoryMutations();
  return {
    ...ingredient,
    ...inventory,
    ...shopping,
    ...recipe,
    ...food,
    ...foodPlan,
    ...meal,
  };
}
