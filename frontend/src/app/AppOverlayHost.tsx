import { normalizeOverlayState, type AppOverlayState, type NormalizedOverlayState } from './appOverlayState';
import type { ReactNode } from 'react';

export type AppOverlayHostProps = {
  state: AppOverlayState;
  render?: (state: NormalizedOverlayState) => ReactNode;
  children?: ReactNode;
};

/**
 * Application-level overlay boundary. The host owns normalization of the
 * discriminated state so consumers can consistently honor busy/escape rules.
 */
export function AppOverlayHost({ state, render, children }: AppOverlayHostProps) {
  const normalizedState = normalizeOverlayState(state);
  return <AppOverlayContent state={normalizedState}>{render ? render(normalizedState) : children}</AppOverlayContent>;
}

export function AppOverlayContent({ state: _state, children }: { state: NormalizedOverlayState; children?: ReactNode }) {
  return children ?? null;
}
