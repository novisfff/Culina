import { describe, expect, it } from 'vitest';
import {
  assertUniqueOwner,
  type AsyncState,
  type WorkspacePort,
} from './appWorkspacePorts';
import { queryOwnership } from './appQueryOwnership';
import { mutationOwnership } from './appMutationOwnership';

describe('app workspace port contracts', () => {
  it('rejects duplicate query owners', () => {
    expect(() => assertUniqueOwner(['home.foodPlan', 'home.foodPlan'])).toThrow(
      'Duplicate owner: home.foodPlan',
    );
  });

  it('preserves AsyncState loading versus fetching', () => {
    const state: AsyncState<string> = {
      data: 'cached',
      isLoading: false,
      isFetching: true,
      error: null,
      retry: () => undefined,
    };
    expect(state.data).toBe('cached');
    expect(state.isLoading).toBe(false);
    expect(state.isFetching).toBe(true);
  });

  it('exposes stable query and mutation ownership maps', () => {
    expect(queryOwnership.foodPlan).toBe('food-plan');
    expect(mutationOwnership.recordMeal).toBe('meal');
  });

  it('allows a typed workspace port without transport fields', () => {
    const port: WorkspacePort<{ title: string }, { refresh: () => void }> = {
      data: { title: 'Home' },
      actions: { refresh: () => undefined },
      navigation: { navigate: () => undefined },
    };
    expect(port.data.title).toBe('Home');
  });
});
