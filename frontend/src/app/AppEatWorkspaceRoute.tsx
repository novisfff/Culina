import type { ComponentProps } from 'react';
import { AppEatWorkspace } from './AppWorkspaceEntries';

export type AppEatWorkspaceRouteProps = ComponentProps<typeof AppEatWorkspace>;

/** Typed route adapter for the Eat workspace and its nested surfaces. */
export function AppEatWorkspaceRoute(props: AppEatWorkspaceRouteProps) {
  return <AppEatWorkspace {...props} />;
}
