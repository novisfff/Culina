import { describe, expect, it } from 'vitest';
import { useAppShellLayoutState } from './useAppShellLayoutState';

describe('app shell layout state', () => {
  it('exports a hook boundary for viewport and sidebar state', () => {
    expect(typeof useAppShellLayoutState).toBe('function');
  });
});
