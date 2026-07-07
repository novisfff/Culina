import type { ReactNode } from 'react';
import { WorkspaceModal, WorkspaceOverlayFrame } from '../ui-kit';

type FoodRecipeEditorDialogProps = {
  children: ReactNode;
  currentRecipeTitle?: string | null;
  isEditing: boolean;
  isSaving?: boolean;
  onClose: () => void;
};

export function FoodRecipeEditorDialog(props: FoodRecipeEditorDialogProps) {
  const isSaving = Boolean(props.isSaving);

  function closeIfAllowed() {
    if (!isSaving) {
      props.onClose();
    }
  }

  return (
    <WorkspaceOverlayFrame
      rootClassName="food-workspace-overlay-root"
      onClose={closeIfAllowed}
      closeOnBackdrop={!isSaving}
    >
      <WorkspaceModal
        title={props.isEditing ? '编辑菜谱和用料' : '添加菜谱和用料'}
        description={props.currentRecipeTitle ? `正在编辑「${props.currentRecipeTitle}」` : '保存后会自动同步为一份家常食物。'}
        eyebrow="食物里的家常菜谱"
        className="food-recipe-editor-modal"
        closeLabel="关闭"
        onClose={closeIfAllowed}
      >
        {props.children}
      </WorkspaceModal>
    </WorkspaceOverlayFrame>
  );
}
