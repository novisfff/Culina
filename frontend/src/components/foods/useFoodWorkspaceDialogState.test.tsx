import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useFoodWorkspaceDialogState } from './useFoodWorkspaceDialogState';

describe('useFoodWorkspaceDialogState', () => {
  it('keeps quick meal and compact record dialogs independent', () => {
    const { result } = renderHook(() => useFoodWorkspaceDialogState());
    act(() => result.current.setIsFoodRecipeEditorOpen(true));
    act(() => result.current.setMobileCookingFilter('shortage'));
    expect(result.current.quickMealDialog).toBeNull();
    expect(result.current.quickRecord).toBeNull();
    expect(result.current.isFoodRecipeEditorOpen).toBe(true);
    expect(result.current.mobileCookingFilter).toBe('shortage');
  });
});
