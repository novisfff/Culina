import type { ReactNode } from 'react';
import { FoodDiscoverSurface } from './FoodDiscoverSurface';

export type FoodWorkspaceDiscoverViewProps = {
  desktopContent: ReactNode;
  mobileContent: ReactNode;
  loading: boolean;
  errorMessage: string | null;
  isEmpty: boolean;
  onCreateFood: () => void;
};

/** Owns the responsive discover surface; the workspace only prepares its data and actions. */
export function FoodWorkspaceDiscoverView({
  desktopContent,
  mobileContent,
  loading,
  errorMessage,
  isEmpty,
  onCreateFood,
}: FoodWorkspaceDiscoverViewProps) {
  return (
    <FoodDiscoverSurface
      desktopContent={desktopContent}
      mobileContent={mobileContent}
      loading={loading}
      errorMessage={errorMessage}
      isEmpty={isEmpty}
      onCreateFood={onCreateFood}
    />
  );
}
