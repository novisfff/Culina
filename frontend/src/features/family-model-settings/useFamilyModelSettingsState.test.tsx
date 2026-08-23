import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
  initialFamilyModelSettingsState,
  reduceFamilyModelSettingsState,
  useFamilyModelSettingsState,
} from './useFamilyModelSettingsState';

describe('useFamilyModelSettingsState', () => {
  it('blocks close and section changes while a sensitive mutation is pending', () => {
    const readyState = {
      ...initialFamilyModelSettingsState,
      overlay: { kind: 'rotate-key', profileId: 'profile-1' } as const,
    };
    const state = reduceFamilyModelSettingsState(readyState, { type: 'busy', action: 'rotate' });

    expect(reduceFamilyModelSettingsState(state, { type: 'close-overlay' })).toBe(state);
    expect(reduceFamilyModelSettingsState(state, { type: 'select-section', section: 'prices' })).toBe(state);
  });

  it('keeps sensitive editor state in React only rather than browser storage', () => {
    const storageSpy = vi.spyOn(Storage.prototype, 'setItem');
    const { result } = renderHook(() => useFamilyModelSettingsState());

    act(() => {
      result.current.actions.markDirty();
      result.current.actions.openOverlay({ kind: 'provider', profileId: null });
      result.current.actions.selectSection('prices');
    });

    expect(result.current.state.dirty).toBe(true);
    expect(storageSpy).not.toHaveBeenCalled();
    storageSpy.mockRestore();
  });
});
