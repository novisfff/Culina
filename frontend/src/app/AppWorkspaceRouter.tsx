import type { AppNavigationState } from './appNavigationModel';
import { resolveWorkspaceRoute } from './appRouteEntries';
import type { ReactNode } from 'react';
import { EmptyState } from '../components/ui-kit';

export function WorkspaceLoadingFallback() {
  return (
    <main className="page-stack">
      <section className="card page-section">
        <EmptyState title="正在准备家庭厨房" description="页面内容正在加载，请稍候。" />
      </section>
    </main>
  );
}

export function AppWorkspaceRouter({ navigationState, render, children }: { navigationState: AppNavigationState; render?: (route: ReturnType<typeof resolveWorkspaceRoute>) => ReactNode; children?: ReactNode }) {
  const route = resolveWorkspaceRoute(navigationState);
  return render ? render(route) : children;
}
