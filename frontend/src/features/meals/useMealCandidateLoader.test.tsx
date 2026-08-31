import { renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { api } from '../../api/client';
import type { MealLogCandidate } from '../../api/types/meal';
import { useMealCandidateLoader } from './useMealCandidateLoader';

describe('useMealCandidateLoader', () => {
  it('loads candidates through the meal API with the requested date and meal type', async () => {
    const candidates: MealLogCandidate[] = [];
    const getMealCandidates = vi
      .spyOn(api, 'getMealCandidates')
      .mockResolvedValue(candidates);
    const { result } = renderHook(() => useMealCandidateLoader());

    await expect(result.current('2026-08-30', 'dinner')).resolves.toBe(candidates);
    expect(getMealCandidates).toHaveBeenCalledWith('2026-08-30', 'dinner');
  });

  it('keeps the loader callback stable across rerenders', () => {
    const { result, rerender } = renderHook(() => useMealCandidateLoader());
    const initialLoader = result.current;

    rerender();

    expect(result.current).toBe(initialLoader);
  });
});
