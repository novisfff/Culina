import type { ComponentProps } from 'react';
import { AppMealLogWorkspace } from './AppWorkspaceEntries';

export type AppMealLogWorkspaceRouteProps = ComponentProps<typeof AppMealLogWorkspace>;

/** Typed route adapter for the Eat history surface. */
export function AppMealLogWorkspaceRoute(props: AppMealLogWorkspaceRouteProps) {
  return <AppMealLogWorkspace {...props} />;
}
