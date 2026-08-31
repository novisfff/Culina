import type { ComponentProps, FormEvent } from 'react';
import { FormActions, WorkspaceModal, WorkspaceOverlayFrame } from '../ui-kit';
import { FoodEditorForm } from './FoodEditorForm';

type EditorProps = ComponentProps<typeof FoodEditorForm>;

export type FoodWorkspaceEditorOverlayProps = {
  open: boolean;
  title: string;
  description: string;
  isSavingFood: boolean;
  isPhoneViewport: boolean;
  onClose: () => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  completedCount: number;
  editor: EditorProps;
};

export function FoodWorkspaceEditorOverlay(props: FoodWorkspaceEditorOverlayProps) {
  if (!props.open) return null;
  const editor = props.editor;
  return (
    <WorkspaceOverlayFrame rootClassName="food-workspace-overlay-root" onClose={props.onClose} busy={props.isSavingFood} closeOnBackdrop={!props.isSavingFood}>
      <WorkspaceModal
        title={props.title}
        description={props.description}
        eyebrow="食物信息"
        className="food-editor-modal"
        closeLabel="关闭"
        busy={props.isSavingFood}
        footerInfo={<><strong>已完成 {props.completedCount} / {editor.completionItems.length} 项信息</strong><span>保存后仍可继续完善</span></>}
        footerActions={<FormActions primaryLabel={editor.submitLabel} submittingLabel="保存中…" primaryType="submit" primaryForm={editor.formId} primaryDisabled={!editor.canSubmit} isSubmitting={props.isSavingFood} secondaryLabel={props.isPhoneViewport ? undefined : '取消'} onSecondary={props.onClose} />}
        onClose={props.onClose}
      >
        <FoodEditorForm {...editor} embedded onSubmit={props.onSubmit} />
      </WorkspaceModal>
    </WorkspaceOverlayFrame>
  );
}
