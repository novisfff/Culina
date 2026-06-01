import type {
  Dispatch,
  FormEventHandler,
  ReactNode,
  SetStateAction,
} from 'react';
import type { OverlayLayerProps } from './IngredientWorkspaceOverlayTypes';
import type { IngredientCreateFormState } from './ingredientWorkspaceForms';
import { IngredientEditorView } from './IngredientEditorView';
import { IngredientWorkspaceFrame } from './IngredientWorkspaceFrame';

type IngredientCreatePageProps = {
  noticeToast: ReactNode;
  overlays: OverlayLayerProps;
  activePanelBackLabel: string;
  ingredientForm: IngredientCreateFormState;
  setIngredientForm: Dispatch<SetStateAction<IngredientCreateFormState>>;
  ingredientVisibleCategoryPresets: Array<{ label: string }>;
  ingredientCategoryIsVisiblePreset: boolean;
  showIngredientCategoryCustomInput: boolean;
  setIngredientCustomCategoryOpen: (next: boolean) => void;
  applyIngredientCategoryPreset: (category: string) => void;
  ingredientUnitAdvancedOpen: boolean;
  setIngredientUnitAdvancedOpen: (next: boolean) => void;
  ingredientUnitOptions: string[];
  ingredientUsesCustomUnit: boolean;
  ingredientUsesCustomStorage: boolean;
  trimmedIngredientUnit: string;
  ingredientDefaultExpiryRangeValue: number;
  ingredientLowStockEnabled: boolean;
  ingredientLowStockValue: number;
  ingredientLowStockStep: number;
  ingredientLowStockQuickValues: number[];
  ingredientPreviewImage: { url: string; alt?: string } | null | undefined;
  createSummaryItems: Array<{ label: string; value: string }>;
  createChecklistItems: Array<{ label: string; done: boolean; optional?: boolean }>;
  createCanSubmit: boolean;
  ingredientImageState: {
    isGenerating: boolean;
    errorMessage: string | null;
  };
  onOpenInventoryOverlay: () => void;
  onOpenShoppingOverlay: () => void;
  onUploadImage: (files: FileList | null) => void;
  onGenerateImage: (mode: 'reference' | 'text') => void;
  onResetImage: () => void;
  onSubmit: FormEventHandler<HTMLFormElement>;
  onSaveWithoutRestock: () => void;
  onOpenCreateView: () => void;
  onBack: () => void;
  isEditingIngredient: boolean;
  isCreatingIngredient?: boolean;
  isUpdatingIngredient?: boolean;
  renderIcon: (name: string) => ReactNode;
  renderStorageIcon: (storage: string) => ReactNode;
  ScrollableChipRail: (props: { ariaLabel: string; railClassName: string; children: ReactNode }) => ReactNode;
};

export function IngredientCreatePage(props: IngredientCreatePageProps) {
  return (
    <IngredientWorkspaceFrame
      noticeToast={props.noticeToast}
      mobileQuickBar={{
        onCreate: props.onOpenCreateView,
        onInventory: props.onOpenInventoryOverlay,
        onShopping: props.onOpenShoppingOverlay,
      }}
      overlays={props.overlays}
    >
      <IngredientEditorView
        activePanelBackLabel={props.activePanelBackLabel}
        isEditingIngredient={props.isEditingIngredient}
        ingredientForm={props.ingredientForm}
        setIngredientForm={props.setIngredientForm}
        ingredientVisibleCategoryPresets={props.ingredientVisibleCategoryPresets}
        ingredientCategoryIsVisiblePreset={props.ingredientCategoryIsVisiblePreset}
        showIngredientCategoryCustomInput={props.showIngredientCategoryCustomInput}
        setIngredientCustomCategoryOpen={props.setIngredientCustomCategoryOpen}
        applyIngredientCategoryPreset={props.applyIngredientCategoryPreset}
        ingredientUnitAdvancedOpen={props.ingredientUnitAdvancedOpen}
        setIngredientUnitAdvancedOpen={props.setIngredientUnitAdvancedOpen}
        ingredientUnitOptions={props.ingredientUnitOptions}
        ingredientUsesCustomUnit={props.ingredientUsesCustomUnit}
        ingredientUsesCustomStorage={props.ingredientUsesCustomStorage}
        trimmedIngredientUnit={props.trimmedIngredientUnit}
        ingredientDefaultExpiryRangeValue={props.ingredientDefaultExpiryRangeValue}
        ingredientLowStockEnabled={props.ingredientLowStockEnabled}
        ingredientLowStockValue={props.ingredientLowStockValue}
        ingredientLowStockStep={props.ingredientLowStockStep}
        ingredientLowStockQuickValues={props.ingredientLowStockQuickValues}
        ingredientPreviewImage={props.ingredientPreviewImage}
        createSummaryItems={props.createSummaryItems}
        createChecklistItems={props.createChecklistItems}
        createCanSubmit={props.createCanSubmit}
        ingredientImageState={props.ingredientImageState}
        onUploadImage={props.onUploadImage}
        onGenerateImage={props.onGenerateImage}
        onResetImage={props.onResetImage}
        onSubmit={props.onSubmit}
        onSaveWithoutRestock={props.onSaveWithoutRestock}
        onBack={props.onBack}
        isCreatingIngredient={props.isCreatingIngredient}
        isUpdatingIngredient={props.isUpdatingIngredient}
        renderIcon={props.renderIcon}
        renderStorageIcon={props.renderStorageIcon}
        ScrollableChipRail={props.ScrollableChipRail}
      />
    </IngredientWorkspaceFrame>
  );
}
