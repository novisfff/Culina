import type { ComponentProps } from 'react';
import { AppFamilyWorkspace } from './AppFamilyWorkspace';

export type AppFamilyWorkspaceRouteProps = ComponentProps<typeof AppFamilyWorkspace>;

/** Typed route adapter for the Family workspace composition. */
export function AppFamilyWorkspaceRoute(props: AppFamilyWorkspaceRouteProps) {
  return <AppFamilyWorkspace {...props} />;
}
