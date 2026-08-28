import { normalizeOverlayState, type AppOverlayState, type NormalizedOverlayState } from './appOverlayState';
import type { ComponentProps, ReactNode } from 'react';
import { AppGlobalOverlays } from './AppGlobalOverlays';

export type AppOverlayHostProps = {
  state: AppOverlayState;
  global?: ComponentProps<typeof AppGlobalOverlays>;
  render?: (state: NormalizedOverlayState) => ReactNode;
  children?: ReactNode;
};

/**
 * Application-level overlay boundary. The host owns normalization of the
 * discriminated state so consumers can consistently honor busy/escape rules.
 */
export function AppOverlayHost({ state, global, render, children }: AppOverlayHostProps) {
  const normalizedState = normalizeOverlayState(state);
  return (
    <AppOverlayContent state={normalizedState} global={global}>
      {render ? render(normalizedState) : children}
    </AppOverlayContent>
  );
}

export function AppOverlayContent({
  state: _state,
  global,
  children,
}: {
  state: NormalizedOverlayState;
  global?: ComponentProps<typeof AppGlobalOverlays>;
  children?: ReactNode;
}) {
  return (
    <>
      {global ? <AppGlobalOverlays {...global} /> : null}
      {children}
    </>
  );
}
