import type { ComponentProps } from 'react';
import { AppAiWorkspace } from './AppWorkspaceEntries';

export type AppAiWorkspaceRouteProps = ComponentProps<typeof AppAiWorkspace>;

/** Route composition adapter; data/actions remain owned by App ports. */
export function AppAiWorkspaceRoute(props: AppAiWorkspaceRouteProps) {
  return <AppAiWorkspace {...props} />;
}
