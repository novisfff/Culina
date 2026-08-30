import type { ComponentProps } from 'react';
import { WorkspaceModal, WorkspaceOverlayFrame } from '../ui-kit';
import { IngredientEditorView } from './IngredientEditorView';
import { IngredientWorkspaceIcon, type IngredientWorkspaceIconName } from './IngredientWorkspaceIcon';
import { IngredientStorageIcon } from './IngredientStorageOverviewCard';
import { ScrollableChipRail } from './ScrollableChipRail';
import { useIngredientEditorState } from './useIngredientEditorState';

type EditorProps = ComponentProps<typeof IngredientEditorView>;
type EditorState = ReturnType<typeof useIngredientEditorState>;

export type IngredientWorkspaceEditorOverlayProps = {
  open: boolean;
  activePanelBackLabel: string;
  ingredientForm: EditorProps['ingredientForm'];
  setIngredientForm: EditorProps['setIngredientForm'];
  editorState: EditorState;
  isCreatingIngredient?: boolean;
  isUpdatingIngredient?: boolean;
  onClose: () => void;
};

/** Owns the editor modal and maps editor controller state to its field view. */
export function IngredientWorkspaceEditorOverlay(props: IngredientWorkspaceEditorOverlayProps) {
  if (!props.open) return null;
  const editor = props.editorState;
  const isSubmitting = Boolean(props.isCreatingIngredient || props.isUpdatingIngredient);
  const renderIcon = (name: string) => <IngredientWorkspaceIcon name={name as IngredientWorkspaceIconName} />;

  return (
    <WorkspaceOverlayFrame
      rootClassName="ingredient-workspace-overlay-root"
      closeOnBackdrop={!isSubmitting}
      onClose={props.onClose}
    >
      <WorkspaceModal
        title={editor.isEditingIngredient ? '编辑食材' : '新增食材'}
        description={editor.isEditingIngredient ? '调整名称、分类、图片和备注后，可以直接保存食材信息。' : '填写基础信息、图片和备注后，就能继续加入库存。'}
        eyebrow="食材信息"
        className="ingredient-editor-modal"
        closeLabel="关闭"
        onClose={props.onClose}
      >
        <IngredientEditorView
          embedded
          activePanelBackLabel={props.activePanelBackLabel}
          isEditingIngredient={editor.isEditingIngredient}
          ingredientForm={props.ingredientForm}
          setIngredientForm={props.setIngredientForm}
          ingredientVisibleCategoryPresets={editor.ingredientVisibleCategoryPresets}
          ingredientCategoryIsVisiblePreset={editor.ingredientCategoryIsVisiblePreset}
          showIngredientCategoryCustomInput={editor.showIngredientCategoryCustomInput}
          setIngredientCustomCategoryOpen={editor.setIngredientCustomCategoryOpen}
          applyIngredientCategoryPreset={editor.applyIngredientCategoryPreset}
          ingredientUnitAdvancedOpen={editor.ingredientUnitAdvancedOpen}
          setIngredientUnitAdvancedOpen={editor.setIngredientUnitAdvancedOpen}
          ingredientUnitOptions={editor.ingredientUnitOptions}
          ingredientUsesCustomUnit={editor.ingredientUsesCustomUnit}
          ingredientUsesCustomStorage={editor.ingredientUsesCustomStorage}
          trimmedIngredientUnit={editor.trimmedIngredientUnit}
          ingredientDefaultExpiryRangeValue={editor.ingredientDefaultExpiryRangeValue}
          ingredientLowStockEnabled={editor.ingredientLowStockEnabled}
          ingredientLowStockValue={editor.ingredientLowStockValue}
          ingredientLowStockStep={editor.ingredientLowStockStep}
          ingredientLowStockQuickValues={editor.ingredientLowStockQuickValues}
          ingredientPreviewImage={editor.ingredientPreviewImage}
          createSummaryItems={editor.createSummaryItems}
          createChecklistItems={editor.createChecklistItems}
          createCanSubmit={editor.createCanSubmit}
          ingredientImageState={editor.ingredientImageComposer.state}
          trackingTransitionDraft={editor.trackingTransitionDraft}
          trackingTransitionBusy={editor.trackingTransitionBusy}
          trackingTransitionError={editor.trackingTransitionError}
          onCancelTrackingTransition={editor.cancelTrackingTransition}
          onUpdatePresenceResolution={editor.updatePresenceResolution}
          onUpdateExactResolution={editor.updateExactResolution}
          onConfirmTrackingTransition={() => void editor.confirmTrackingTransition()}
          onUploadImage={(files) => void editor.ingredientImageComposer.upload(files)}
          onGenerateImage={(mode) => void editor.ingredientImageComposer.generate(mode)}
          onResetImage={editor.ingredientImageComposer.reset}
          onSubmit={editor.handleCreateSubmit}
          onSaveWithoutRestock={() => void editor.submitIngredient(false)}
          onBack={props.onClose}
          isCreatingIngredient={props.isCreatingIngredient}
          isUpdatingIngredient={props.isUpdatingIngredient}
          renderIcon={renderIcon}
          renderStorageIcon={(storage) => <IngredientStorageIcon storage={storage} />}
          ScrollableChipRail={ScrollableChipRail}
        />
      </WorkspaceModal>
    </WorkspaceOverlayFrame>
  );
}
