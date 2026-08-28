import { lazy, Suspense, type ComponentProps } from 'react';
import type { GlobalSearchOverlayProps } from '../features/search/GlobalSearchOverlay';

const GlobalSearchOverlay = lazy(() => import('../features/search/GlobalSearchOverlay').then((module) => ({ default: module.GlobalSearchOverlay })));
const IngredientShoppingDialog = lazy(() => import('../components/ingredients/IngredientShoppingDialog').then((module) => ({ default: module.IngredientShoppingDialog })));

type Props = {
  search: GlobalSearchOverlayProps;
  shopping: ComponentProps<typeof IngredientShoppingDialog>;
};

export function AppGlobalOverlays({ search, shopping }: Props) {
  return (
    <>
      <Suspense fallback={null}>
        <GlobalSearchOverlay {...search} />
      </Suspense>
      <IngredientShoppingDialog {...shopping} />
    </>
  );
}
