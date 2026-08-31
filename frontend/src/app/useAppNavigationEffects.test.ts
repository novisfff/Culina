import { describe, expect, it } from 'vitest';
import { navigationEffectKey } from './useAppNavigationEffects';

describe('app navigation effects', () => {
  it('creates a stable key from route identity without task payload details', () => {
    expect(navigationEffectKey({ primaryTab: 'eat', eatBaseView: 'history', taskKind: 'meal-detail', familyView: 'profile' })).toBe('eat|history|meal-detail|profile');
  });
});
