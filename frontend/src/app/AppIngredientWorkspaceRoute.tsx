import type { ComponentProps } from 'react';
import { AppIngredientWorkspace } from './AppWorkspaceEntries';

export type AppIngredientWorkspaceRouteProps = ComponentProps<typeof AppIngredientWorkspace>;

/** Typed route adapter for the Ingredient workspace. */
export function AppIngredientWorkspaceRoute(props: AppIngredientWorkspaceRouteProps) {
  return <AppIngredientWorkspace {...props} />;
}
