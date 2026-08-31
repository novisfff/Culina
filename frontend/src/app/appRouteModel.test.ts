import { describe, expect, it } from 'vitest';
import { primaryTabToTarget, querySettleStatus } from './appRouteModel';

describe('app route model', () => {
  it('preserves the current eat view only within eat', () => {
    expect(primaryTabToTarget('eat', 'plan', true)).toEqual({ workspace: 'eat', view: 'plan' });
    expect(primaryTabToTarget('home', 'plan', false)).toEqual({ workspace: 'home' });
  });
  it('projects query lifecycle to a stable status', () => {
    expect(querySettleStatus({ isError: true })).toBe('error');
    expect(querySettleStatus({ isSuccess: true })).toBe('success');
  });
});
