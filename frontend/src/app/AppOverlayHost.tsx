import { normalizeOverlayState, type AppOverlayState, type NormalizedOverlayState } from './appOverlayState';
import type { ComponentProps } from 'react';
import { AppGlobalOverlays } from './AppGlobalOverlays';
import { AppHomeDashboardDialogs, type AppHomeDashboardDialogsProps } from './AppHomeDashboardDialogs';
import {
  AppInventoryMaintenanceDialogs,
  type AppInventoryMaintenanceDialogsProps,
} from './AppInventoryMaintenanceDialogs';

export type AppOverlayHostProps = {
  state: AppOverlayState;
  global?: ComponentProps<typeof AppGlobalOverlays>;
  home?: AppHomeDashboardDialogsProps;
  inventory?: AppInventoryMaintenanceDialogsProps;
};

/**
 * Application-level overlay boundary. The host owns normalization of the
 * discriminated state so consumers can consistently honor busy/escape rules.
 */
export function AppOverlayHost({ state, global, home, inventory }: AppOverlayHostProps) {
  const normalizedState = normalizeOverlayState(state);
  return <AppOverlayContent state={normalizedState} global={global} home={home} inventory={inventory} />;
}

export function AppOverlayContent({
  state: _state,
  global,
  home,
  inventory,
}: {
  state: NormalizedOverlayState;
  global?: ComponentProps<typeof AppGlobalOverlays>;
  home?: AppHomeDashboardDialogsProps;
  inventory?: AppInventoryMaintenanceDialogsProps;
}) {
  return (
    <>
      {global ? <AppGlobalOverlays {...global} /> : null}
      {home ? <AppHomeDashboardDialogs {...home} /> : null}
      {inventory ? <AppInventoryMaintenanceDialogs {...inventory} /> : null}
    </>
  );
}
