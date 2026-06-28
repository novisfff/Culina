import type { Dispatch, MutableRefObject, SetStateAction, UIEvent } from 'react';
import type { ShoppingListItem } from '../api/types';
import {
  DASHBOARD_TODO_PAGE_SIZE,
  buildHomeRestockForm,
  type DashboardExpiryTodoInventoryItem,
  type DashboardTodoItem,
  type HomeRestockFormState,
} from '../features/home/homeDashboardModel';
import type { TabKey } from './AppShell';
import type { IngredientNavigationRequest } from './useAppGlobalSearchNavigation';

type UseAppHomeHandlersArgs = {
  ingredientNavigationRequestIdRef: MutableRefObject<number>;
  setIngredientNavigationRequest: Dispatch<SetStateAction<IngredientNavigationRequest | null>>;
  setActiveTab: Dispatch<SetStateAction<TabKey>>;
  setHomeExpiredDisposalIngredientId: Dispatch<SetStateAction<string | null>>;
  setHomeExpiryReviewItemId: Dispatch<SetStateAction<string | null>>;
  setHomeRestockShoppingItemId: Dispatch<SetStateAction<string | null>>;
  setHomeRestockForm: Dispatch<SetStateAction<HomeRestockFormState | null>>;
  setHomeMealDetailId: Dispatch<SetStateAction<string | null>>;
  setVisibleExpiryCount: Dispatch<SetStateAction<number>>;
  setVisibleDashboardTodoCount: Dispatch<SetStateAction<number>>;
  ingredients: Parameters<typeof buildHomeRestockForm>[1];
  expiringInventoryCount: number;
  dashboardTodoCount: number;
};

export function useAppHomeHandlers(args: UseAppHomeHandlersArgs) {
  function openIngredientsCatalog() {
    args.ingredientNavigationRequestIdRef.current += 1;
    args.setIngredientNavigationRequest({
      view: 'catalog',
      requestId: args.ingredientNavigationRequestIdRef.current,
    });
    args.setActiveTab('ingredients');
  }

  function openIngredientDetail(ingredientId: string) {
    args.ingredientNavigationRequestIdRef.current += 1;
    args.setIngredientNavigationRequest({
      view: 'detail',
      ingredientId,
      requestId: args.ingredientNavigationRequestIdRef.current,
    });
    args.setActiveTab('ingredients');
  }

  function openIngredientExpiredDisposal(ingredientId: string) {
    args.setHomeExpiredDisposalIngredientId(ingredientId);
  }

  function openHomeExpiryReview(item: DashboardExpiryTodoInventoryItem) {
    args.setHomeExpiryReviewItemId(item.id);
  }

  function closeHomeExpiryReview() {
    args.setHomeExpiryReviewItemId(null);
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
    if (item.type === 'expiry') {
      if (item.item.daysLeft < 0) {
        openIngredientExpiredDisposal(item.item.ingredient_id);
        return;
      }
      openHomeExpiryReview(item.item);
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

  function handleExpiryListScroll(event: UIEvent<HTMLDivElement>) {
    const target = event.currentTarget;
    if (target.scrollTop + target.clientHeight < target.scrollHeight - 24) {
      return;
    }
    args.setVisibleExpiryCount((current) => Math.min(current + 10, args.expiringInventoryCount));
  }

  function handleDashboardTodoListScroll(event: UIEvent<HTMLDivElement>) {
    const target = event.currentTarget;
    if (target.scrollTop + target.clientHeight < target.scrollHeight - 18) {
      return;
    }
    args.setVisibleDashboardTodoCount((current) => Math.min(current + DASHBOARD_TODO_PAGE_SIZE, args.dashboardTodoCount));
  }

  return {
    openIngredientsCatalog,
    openIngredientDetail,
    openIngredientExpiredDisposal,
    openHomeExpiryReview,
    closeHomeExpiryReview,
    openHomeRestock,
    closeHomeRestock,
    closeHomeMealDetail,
    handleDashboardTodoClick,
    updateHomeRestockForm,
    handleExpiryListScroll,
    handleDashboardTodoListScroll,
  };
}
