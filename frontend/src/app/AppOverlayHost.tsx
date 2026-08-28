import type { AppOverlayState } from './appOverlayState';
import type { ReactNode } from 'react';

export function AppOverlayHost({ state, render, children }: { state: AppOverlayState; render?: (state: AppOverlayState) => ReactNode; children?: ReactNode }) {
  return render ? render(state) : children;
}
