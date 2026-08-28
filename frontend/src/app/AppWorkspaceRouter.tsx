import type { AppNavigationState } from './appNavigationModel';
import { resolveWorkspaceRoute } from './appRouteEntries';
import type { ReactNode } from 'react';

export function AppWorkspaceRouter({ navigationState, render }: { navigationState: AppNavigationState; render: (route: ReturnType<typeof resolveWorkspaceRoute>) => ReactNode }) {
  return render(resolveWorkspaceRoute(navigationState));
}
