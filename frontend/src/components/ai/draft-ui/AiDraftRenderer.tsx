import type { ReactNode } from 'react';
import type { AiApprovalRequest, AiGeneratedRecipeDraft, Ingredient } from '../../../api/types';
import type { AiResourceOption, AiResourceOptionLoader } from '../AiApprovalFields';
import { AiGeneratedRecipeDraftView } from './views/AiGeneratedRecipeDraftView';
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
  ingredientOptions: readonly AiResourceOption[];
  ingredients: readonly Ingredient[];
  recipeCookSchemaVersion: 'recipe_cook_operation.v1' | 'recipe_cook_operation.v2' | 'unknown';
  recipeCookRequiresRegeneration: boolean;
  onRecipeChange: (next: AiGeneratedRecipeDraft) => void;
  onStructuredDraftChange: (next: Record<string, unknown>) => void;
  onLoadResourceOptions: AiResourceOptionLoader;
  renderLegacyFallback: () => ReactNode;
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
    case 'meal_log':
    case 'food_profile':
    case 'ingredient_profile':
    case 'inventory_operation':
    case 'composite_operation':
      return <>{props.renderLegacyFallback()}</>;
    default:
      return <>{props.renderLegacyFallback()}</>;
  }
}
