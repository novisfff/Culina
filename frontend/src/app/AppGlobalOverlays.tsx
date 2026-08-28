import type { ComponentProps } from 'react';
import { GlobalSearchOverlay } from '../features/search/GlobalSearchOverlay';
import { IngredientShoppingDialog } from '../components/ingredients/IngredientShoppingDialog';

type Props = {
  search: ComponentProps<typeof GlobalSearchOverlay>;
  shopping: ComponentProps<typeof IngredientShoppingDialog>;
};

export function AppGlobalOverlays({ search, shopping }: Props) {
  return (
    <>
      <GlobalSearchOverlay {...search} />
      <IngredientShoppingDialog {...shopping} />
    </>
  );
}
