import { describe, expect, it } from 'vitest';
import { mutationOwnership } from '../appMutationOwnership';

describe('domain mutation contracts', () => {
  it('tracks the complete mutation surface with one owner per action', () => {
    const names = Object.keys(mutationOwnership);
    expect(names.length).toBe(39);
    expect(new Set(names).size).toBe(names.length);
    expect(Object.values(mutationOwnership).every(Boolean)).toBe(true);
  });

  it('keeps the no-invalidation transition action explicit', () => {
    expect(mutationOwnership.transitionIngredientTrackingMode).toBe('ingredient');
  });
});
