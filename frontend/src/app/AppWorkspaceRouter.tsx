import type { AppNavigationState } from './appNavigationModel';
import { resolveWorkspaceRoute, type WorkspaceRoute } from './appRouteEntries';
import { Suspense, type ReactNode } from 'react';
import { PageLoadingState } from '../components/ui-kit';

export function WorkspaceLoadingFallback() {
  return <PageLoadingState title="家庭厨房" description="页面内容正在加载，请稍候。" eyebrow="正在准备" />;
}

export function WorkspaceRouteBoundary({ children }: { children: ReactNode }) {
  return <Suspense fallback={<WorkspaceLoadingFallback />}>{children}</Suspense>;
}

export function AppWorkspaceRouter({
  navigationState,
  render,
  routes,
  children,
}: {
  navigationState: AppNavigationState;
  render?: (route: ReturnType<typeof resolveWorkspaceRoute>) => ReactNode;
  routes?: Partial<Record<WorkspaceRoute['workspace'], ReactNode>>;
  children?: ReactNode;
}) {
  const route = resolveWorkspaceRoute(navigationState);
  return render ? render(route) : routes?.[route.workspace] ?? children;
}
