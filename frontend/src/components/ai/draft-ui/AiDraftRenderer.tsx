import type { AiApprovalRequest, AiGeneratedRecipeDraft, Ingredient } from '../../../api/types';
import type { AiResourceOption, AiResourceOptionLoader } from '../AiApprovalFields';
import { AiCompositeOperationPreview } from '../AiCompositeOperationPreview';
import { AiInventoryIntakeApproval } from '../AiInventoryIntakeApproval';
import { AiInventoryOperationEditor } from '../AiInventoryOperationEditor';
import { inventoryOperationDraftFromRecord } from '../aiInventoryOperationDraftModel';
import { asDraftArray, asText } from '../aiDraftValueUtils';
import {
  AiIngredientTrackingTransitionApproval,
  AiMealCompositionCorrectionApproval,
} from '../AiSpecializedApprovalEditors';
import { AiFoodProfileDraftView } from './views/AiFoodProfileDraftView';
import { AiGeneratedRecipeDraftView } from './views/AiGeneratedRecipeDraftView';
import { AiIngredientProfileDraftView } from './views/AiIngredientProfileDraftView';
import { AiMealLogDraftView } from './views/AiMealLogDraftView';
import { AiMealPlanDraftView } from './views/AiMealPlanDraftView';
import { AiRecipeCookDraftView } from './views/AiRecipeCookDraftView';
import { AiRecipeOperationDraftView } from './views/AiRecipeOperationDraftView';
import { AiShoppingListDraftView } from './views/AiShoppingListDraftView';

export type AiDraftRendererProps = {
  approval: AiApprovalRequest;
  draftType: string;
  recipeApproval: boolean;
  recipe: AiGeneratedRecipeDraft;
  structuredDraft: Record<string, unknown>;
  readonly: boolean;
  foodOptions: readonly AiResourceOption[];
  foodCategoryOptions: Array<{ value: string; label: string; description?: string }>;
  ingredientOptions: readonly AiResourceOption[];
  ingredients: readonly Ingredient[];
  recipeCookSchemaVersion: 'recipe_cook_operation.v1' | 'recipe_cook_operation.v2' | 'unknown';
  recipeCookRequiresRegeneration: boolean;
  onRecipeChange: (next: AiGeneratedRecipeDraft) => void;
  onStructuredDraftChange: (next: Record<string, unknown>) => void;
  onLoadResourceOptions: AiResourceOptionLoader;
};

export function AiDraftRenderer(props: AiDraftRendererProps) {
  if (props.recipeApproval) {
    return (
      <AiGeneratedRecipeDraftView
        recipe={props.recipe}
        readonly={props.readonly}
        status={props.approval.status}
        ingredients={props.ingredients}
        ingredientOptions={props.ingredientOptions}
        onRecipeChange={props.onRecipeChange}
        onLoadResourceOptions={props.onLoadResourceOptions}
      />
    );
  }

  switch (props.draftType) {
    case 'recipe':
      return (
        <AiRecipeOperationDraftView
          draft={props.structuredDraft}
          readonly={props.readonly}
          status={props.approval.status}
          ingredients={props.ingredients}
          ingredientOptions={props.ingredientOptions}
          onDraftChange={props.onStructuredDraftChange}
          onLoadResourceOptions={props.onLoadResourceOptions}
        />
      );
    case 'recipe_cook':
      return (
        <AiRecipeCookDraftView
          draft={props.structuredDraft}
          readonly={props.readonly}
          status={props.approval.status}
          schemaVersion={props.recipeCookSchemaVersion}
          requiresRegeneration={props.recipeCookRequiresRegeneration}
          onDraftChange={props.onStructuredDraftChange}
        />
      );
    case 'meal_plan':
      return (
        <AiMealPlanDraftView
          draft={props.structuredDraft}
          readonly={props.readonly}
          status={props.approval.status}
          foodOptions={props.foodOptions}
          ingredientOptions={props.ingredientOptions}
          onDraftChange={props.onStructuredDraftChange}
          onLoadResourceOptions={props.onLoadResourceOptions}
        />
      );
    case 'shopping_list':
      return (
        <AiShoppingListDraftView
          draft={props.structuredDraft}
          readonly={props.readonly}
          status={props.approval.status}
          ingredientOptions={props.ingredientOptions}
          onDraftChange={props.onStructuredDraftChange}
          onLoadResourceOptions={props.onLoadResourceOptions}
        />
      );
    case 'inventory_intake':
      return (
        <AiInventoryIntakeApproval
          draft={props.structuredDraft}
          readonly={props.readonly}
          status={props.approval.status}
          onChange={props.onStructuredDraftChange}
        />
      );
    case 'meal_log':
      if (asText(props.structuredDraft.action) === 'update_composition') {
        return (
          <AiMealCompositionCorrectionApproval
            draft={props.structuredDraft}
            readonly={props.readonly}
            status={props.approval.status}
            onChange={props.onStructuredDraftChange}
          />
        );
      }
      return (
        <AiMealLogDraftView
          draft={props.structuredDraft}
          readonly={props.readonly}
          status={props.approval.status}
          foodOptions={props.foodOptions}
          onDraftChange={props.onStructuredDraftChange}
          onLoadResourceOptions={props.onLoadResourceOptions}
        />
      );
    case 'food_profile':
      return (
        <AiFoodProfileDraftView
          draft={props.structuredDraft}
          readonly={props.readonly}
          status={props.approval.status}
          categoryOptions={props.foodCategoryOptions}
          onDraftChange={props.onStructuredDraftChange}
        />
      );
    case 'ingredient_profile':
      if (asText(props.structuredDraft.action) === 'transition_tracking_mode') {
        return (
          <AiIngredientTrackingTransitionApproval
            draft={props.structuredDraft}
            readonly={props.readonly}
            status={props.approval.status}
            onChange={props.onStructuredDraftChange}
          />
        );
      }
      return (
        <AiIngredientProfileDraftView
          draft={props.structuredDraft}
          readonly={props.readonly}
          status={props.approval.status}
          onDraftChange={props.onStructuredDraftChange}
        />
      );
    case 'inventory_operation': {
      const draft = inventoryOperationDraftFromRecord(props.structuredDraft);
      return (
        <AiInventoryOperationEditor
          draft={draft}
          readonly={props.readonly}
          status={props.approval.status}
          onUpdateItem={(index, patch) => {
            const operations = asDraftArray(props.structuredDraft.operations);
            props.onStructuredDraftChange({
              ...props.structuredDraft,
              operations: operations.map((item, itemIndex) => (
                itemIndex === index ? { ...item, ...patch } : item
              )),
            });
          }}
          onRemoveItem={(index) => {
            const operations = asDraftArray(props.structuredDraft.operations);
            if (operations.length <= 1) return;
            props.onStructuredDraftChange({
              ...props.structuredDraft,
              operations: operations.filter((_, itemIndex) => itemIndex !== index),
            });
          }}
        />
      );
    }
    case 'composite_operation':
      return (
        <AiCompositeOperationPreview
          draft={props.structuredDraft}
          status={props.approval.status}
          readonly={props.readonly}
        />
      );
    default:
      return null;
  }
}
