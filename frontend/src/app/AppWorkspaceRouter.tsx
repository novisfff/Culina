import type { AppNavigationState } from './appNavigationModel';
import { resolveWorkspaceRoute } from './appRouteEntries';
import type { ReactNode } from 'react';

export function AppWorkspaceRouter({ navigationState, render, children }: { navigationState: AppNavigationState; render?: (route: ReturnType<typeof resolveWorkspaceRoute>) => ReactNode; children?: ReactNode }) {
  const route = resolveWorkspaceRoute(navigationState);
  return render ? render(route) : children;
}
