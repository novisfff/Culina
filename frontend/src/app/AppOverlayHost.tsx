import type { AppOverlayState } from './appOverlayState';
import type { ReactNode } from 'react';

export function AppOverlayHost({ state, render }: { state: AppOverlayState; render: (state: AppOverlayState) => ReactNode }) {
  return render(state);
}
