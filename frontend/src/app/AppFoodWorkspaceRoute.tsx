import type { ComponentProps } from 'react';
import { AppFoodWorkspace } from './AppWorkspaceEntries';

export type AppFoodWorkspaceRouteProps = ComponentProps<typeof AppFoodWorkspace>;

/** Typed route adapter for the Food workspace embedded in Eat discovery. */
export function AppFoodWorkspaceRoute(props: AppFoodWorkspaceRouteProps) {
  return <AppFoodWorkspace {...props} />;
}
