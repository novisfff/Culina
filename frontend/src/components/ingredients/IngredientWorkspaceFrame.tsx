import type { ReactNode } from 'react';
import { IngredientMobileQuickBar } from './IngredientWorkspacePanels';
import { IngredientWorkspaceOverlays } from './IngredientWorkspaceOverlays';
import type { OverlayLayerProps } from './IngredientWorkspaceOverlayTypes';

type IngredientWorkspaceFrameProps = {
  noticeToast: ReactNode;
  children: ReactNode;
  mobileQuickBar: {
    onCreate: () => void;
    onInventory: () => void;
    onShopping: () => void;
  };
  overlays: OverlayLayerProps;
};

export function IngredientWorkspaceFrame(props: IngredientWorkspaceFrameProps) {
  return (
    <div className="ingredients-workspace">
      {props.noticeToast}
      {props.children}
      <IngredientMobileQuickBar
        onCreate={props.mobileQuickBar.onCreate}
        onInventory={props.mobileQuickBar.onInventory}
        onShopping={props.mobileQuickBar.onShopping}
      />
      <IngredientWorkspaceOverlays {...props.overlays} />
    </div>
  );
}
