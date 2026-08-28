import type { AppNavigationState } from './appNavigationModel';

export type WorkspaceRoute = { workspace: AppNavigationState['primaryTab']; task: AppNavigationState['eat']['task'] | null };

export function resolveWorkspaceRoute(state: AppNavigationState): WorkspaceRoute {
  return { workspace: state.primaryTab, task: state.primaryTab === 'eat' ? state.eat.task : null };
}
