import type { ComponentProps } from 'react';
import { AppHomeDashboard } from './AppWorkspaceEntries';

export type AppHomeWorkspaceRouteProps = ComponentProps<typeof AppHomeDashboard>;

/** Typed route adapter for the home dashboard. */
export function AppHomeWorkspaceRoute(props: AppHomeWorkspaceRouteProps) {
  return <AppHomeDashboard {...props} />;
}
