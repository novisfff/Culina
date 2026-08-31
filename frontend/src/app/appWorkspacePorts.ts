import type { AppNavigationTarget } from './appNavigationModel';

export type AsyncState<T> = {
  data: T;
  isLoading: boolean;
  isFetching: boolean;
  error: unknown | null;
  retry: () => void;
};

export type WorkspaceId = 'home' | 'eat' | 'ingredients' | 'food' | 'ai' | 'family';

export type AppNavigationService = {
  navigate: (target: AppNavigationTarget) => void;
};

export type WorkspacePort<Data, Actions> = {
  data: Data;
  actions: Actions;
  navigation: AppNavigationService;
};

export function assertUniqueOwner(names: readonly string[]): void {
  const seen = new Set<string>();
  for (const name of names) {
    if (seen.has(name)) {
      throw new Error(`Duplicate owner: ${name}`);
    }
    seen.add(name);
  }
}
