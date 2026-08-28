import { describe, expect, it } from 'vitest';
import { normalizeOverlayState, type AppOverlayState } from './appOverlayState';

describe('AppOverlayHost overlay contract', () => {
  it('represents no overlay as a single discriminated state', () => {
    expect(normalizeOverlayState({ kind: 'none' })).toEqual({ kind: 'none' });
  });
  it('does not allow busy overlays to close via escape', () => {
    const state: AppOverlayState = { kind: 'home-dialogs', dialog: 'shopping', busy: true };
    expect(normalizeOverlayState(state).canEscapeClose).toBe(false);
  });
});
