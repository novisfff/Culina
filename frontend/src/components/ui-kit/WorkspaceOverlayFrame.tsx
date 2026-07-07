import type { ReactNode } from 'react';

export type WorkspaceOverlayFrameProps = {
  children: ReactNode;
  onClose: () => void;
  rootClassName?: string;
  backdropClassName?: string;
  closeOnBackdrop?: boolean;
};

export function WorkspaceOverlayFrame({
  children,
  onClose,
  rootClassName,
  backdropClassName,
  closeOnBackdrop = true,
}: WorkspaceOverlayFrameProps) {
  return (
    <div className={['workspace-overlay-root', rootClassName].filter(Boolean).join(' ')}>
      <div
        className={['workspace-overlay-backdrop', backdropClassName].filter(Boolean).join(' ')}
        onClick={closeOnBackdrop ? onClose : undefined}
      />
      {children}
    </div>
  );
}
