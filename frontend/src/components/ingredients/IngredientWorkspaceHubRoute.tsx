import type { ReactNode } from 'react';
import { IngredientHubPage, type IngredientHubPageProps } from './IngredientHubPage';
import { IngredientInventoryPanelContextProvider } from './IngredientWorkspacePanels';

type IngredientWorkspaceHubRouteProps = {
  pageProps: IngredientHubPageProps;
  inventoryPanelContext: Parameters<typeof IngredientInventoryPanelContextProvider>[0]['value'];
};

/** Owns the route-level inventory context boundary around the ingredient hub view. */
export function IngredientWorkspaceHubRoute({
  pageProps,
  inventoryPanelContext,
}: IngredientWorkspaceHubRouteProps): ReactNode {
  return (
    <IngredientInventoryPanelContextProvider value={inventoryPanelContext}>
      <IngredientHubPage {...pageProps} />
    </IngredientInventoryPanelContextProvider>
  );
}
