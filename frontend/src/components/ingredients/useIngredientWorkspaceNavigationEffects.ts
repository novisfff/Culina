import { useEffect, useRef } from 'react';
import type { Ingredient } from '../../api/types';

export type IngredientNavigationRequest =
  | { target: 'catalog'; requestId: number }
  | { target: 'create'; requestId: number }
  | { target: 'detail'; ingredientId: string; requestId: number }
  | { target: 'shopping'; ingredientId: string; requestId: number }
  | { target: 'priority'; requestId: number }
  | null
  | undefined;

type Args = {
  ingredients: Ingredient[];
  navigationRequest: IngredientNavigationRequest;
  onNavigationRequestConsumed?: (requestId: number) => void;
  openCreateView: () => void;
  openShoppingOverlay: (args: { ingredient: Ingredient; reason: string }) => void;
};

/** Handles one-shot navigation requests that trigger overlays, focus, or scrolling. */
export function useIngredientWorkspaceNavigationEffects(args: Args) {
  const handledRequestIdRef = useRef<number | null>(null);

  useEffect(() => {
    const request = args.navigationRequest;
    if (!request || handledRequestIdRef.current === request.requestId) return;

    if (request.target === 'shopping') {
      const ingredient = args.ingredients.find((item) => item.id === request.ingredientId);
      if (!ingredient) return;
      handledRequestIdRef.current = request.requestId;
      args.openShoppingOverlay({ ingredient, reason: '库存不足' });
      args.onNavigationRequestConsumed?.(request.requestId);
      return;
    }

    if (request.target === 'create') {
      handledRequestIdRef.current = request.requestId;
      args.openCreateView();
      args.onNavigationRequestConsumed?.(request.requestId);
      return;
    }

    if (request.target !== 'priority') return;
    handledRequestIdRef.current = request.requestId;
    const focusPrioritySurface = () => {
      const mobileSection = document.getElementById('mobile-ingredient-priority');
      if (mobileSection) {
        mobileSection.scrollIntoView({ block: 'start', behavior: 'smooth' });
        mobileSection.focus?.({ preventScroll: true });
        return;
      }
      const desktopList =
        document.getElementById('ingredient-priority-list') ??
        document.querySelector('.ingredients-catalog-grid, .ingredient-grid-catalog');
      if (desktopList instanceof HTMLElement) {
        desktopList.scrollIntoView({ block: 'start', behavior: 'smooth' });
        desktopList.focus?.({ preventScroll: true });
      }
    };

    window.requestAnimationFrame(() => window.setTimeout(focusPrioritySurface, 0));
    args.onNavigationRequestConsumed?.(request.requestId);
  }, [args.ingredients, args.navigationRequest?.requestId, args.onNavigationRequestConsumed]);
}
