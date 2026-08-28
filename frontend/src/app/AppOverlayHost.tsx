import { normalizeOverlayState, type AppOverlayState, type NormalizedOverlayState } from './appOverlayState';
import type { ComponentProps, ReactNode } from 'react';
import { AppGlobalOverlays } from './AppGlobalOverlays';
import { AppHomeDashboardDialogs, type AppHomeDashboardDialogsProps } from './AppHomeDashboardDialogs';

export type AppOverlayHostProps = {
  state: AppOverlayState;
  global?: ComponentProps<typeof AppGlobalOverlays>;
  home?: AppHomeDashboardDialogsProps;
  render?: (state: NormalizedOverlayState) => ReactNode;
  children?: ReactNode;
};

/**
 * Application-level overlay boundary. The host owns normalization of the
 * discriminated state so consumers can consistently honor busy/escape rules.
 */
export function AppOverlayHost({ state, global, home, render, children }: AppOverlayHostProps) {
  const normalizedState = normalizeOverlayState(state);
  return (
    <AppOverlayContent state={normalizedState} global={global} home={home}>
      {render ? render(normalizedState) : children}
    </AppOverlayContent>
  );
}

export function AppOverlayContent({
  state: _state,
  global,
  home,
  children,
}: {
  state: NormalizedOverlayState;
  global?: ComponentProps<typeof AppGlobalOverlays>;
  home?: AppHomeDashboardDialogsProps;
  children?: ReactNode;
}) {
  return (
    <>
      {global ? <AppGlobalOverlays {...global} /> : null}
      {home ? <AppHomeDashboardDialogs {...home} /> : null}
      {children}
    </>
  );
}
