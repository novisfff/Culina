import type { Dispatch, MutableRefObject, SetStateAction } from 'react';
import type { ShoppingListItem } from '../api/types';
import {
  buildHomeRestockForm,
  type DashboardTodoItem,
  type HomeRestockFormState,
} from '../features/home/homeDashboardModel';
import type { TabKey } from './AppShell';
import type { IngredientNavigationRequest } from './useAppGlobalSearchNavigation';

type UseAppHomeHandlersArgs = {
  ingredientNavigationRequestIdRef: MutableRefObject<number>;
  setIngredientNavigationRequest: Dispatch<SetStateAction<IngredientNavigationRequest | null>>;
  setActiveTab: Dispatch<SetStateAction<TabKey>>;
  setHomeRestockShoppingItemId: Dispatch<SetStateAction<string | null>>;
  setHomeRestockForm: Dispatch<SetStateAction<HomeRestockFormState | null>>;
  setHomeMealDetailId: Dispatch<SetStateAction<string | null>>;
  ingredients: Parameters<typeof buildHomeRestockForm>[1];
};

export function useAppHomeHandlers(args: UseAppHomeHandlersArgs) {
  function nextIngredientRequestId() {
    args.ingredientNavigationRequestIdRef.current += 1;
    return args.ingredientNavigationRequestIdRef.current;
  }

  function openIngredientsCatalog() {
    args.setIngredientNavigationRequest({
      target: 'catalog',
      requestId: nextIngredientRequestId(),
    });
    args.setActiveTab('ingredients');
  }

  function openIngredientDetail(ingredientId: string) {
    args.setIngredientNavigationRequest({
      target: 'detail',
      ingredientId,
      requestId: nextIngredientRequestId(),
    });
    args.setActiveTab('ingredients');
  }

  function openIngredientShopping(ingredientId: string) {
    args.setIngredientNavigationRequest({
      target: 'shopping',
      ingredientId,
      requestId: nextIngredientRequestId(),
    });
    args.setActiveTab('ingredients');
  }

  function openIngredientPriority() {
    args.setIngredientNavigationRequest({
      target: 'priority',
      requestId: nextIngredientRequestId(),
    });
    args.setActiveTab('ingredients');
  }

  function openHomeRestock(item: ShoppingListItem) {
    args.setHomeRestockShoppingItemId(item.id);
    args.setHomeRestockForm(buildHomeRestockForm(item, args.ingredients));
  }

  function closeHomeRestock() {
    args.setHomeRestockShoppingItemId(null);
    args.setHomeRestockForm(null);
  }

  function closeHomeMealDetail() {
    args.setHomeMealDetailId(null);
  }

  function handleDashboardTodoClick(item: DashboardTodoItem) {
    // Legacy todo path retained until Task 7B replaces the home surface.
    // Shopping/meal remain; expiry rows will be driven by inventory action groups.
    if (item.type === 'expiry') {
      openIngredientDetail(item.item.ingredient_id);
      return;
    }
    if (item.type === 'shopping') {
      openHomeRestock(item.item);
      return;
    }
    args.setHomeMealDetailId(item.item.id);
  }

  function updateHomeRestockForm(next: HomeRestockFormState) {
    args.setHomeRestockForm(next);
  }

  return {
    openIngredientsCatalog,
    openIngredientDetail,
    openIngredientShopping,
    openIngredientPriority,
    openHomeRestock,
    closeHomeRestock,
    closeHomeMealDetail,
    handleDashboardTodoClick,
    updateHomeRestockForm,
  };
}
