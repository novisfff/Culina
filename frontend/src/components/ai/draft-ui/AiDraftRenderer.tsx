import type { ReactNode } from 'react';
import type { AiApprovalRequest, AiGeneratedRecipeDraft } from '../../../api/types';
import type { AiResourceOption, AiResourceOptionLoader } from '../AiApprovalFields';

export type AiDraftRendererProps = {
  approval: AiApprovalRequest;
  draftType: string;
  recipeApproval: boolean;
  recipe: AiGeneratedRecipeDraft;
  structuredDraft: Record<string, unknown>;
  readonly: boolean;
  foodOptions: readonly AiResourceOption[];
  ingredientOptions: readonly AiResourceOption[];
  onRecipeChange: (next: AiGeneratedRecipeDraft) => void;
  onStructuredDraftChange: (next: Record<string, unknown>) => void;
  onLoadResourceOptions: AiResourceOptionLoader;
  renderLegacyFallback: () => ReactNode;
  children?: ReactNode;
};

export function AiDraftRenderer(props: AiDraftRendererProps) {
  if (props.recipeApproval && props.children) {
    return <>{props.children}</>;
  }

  switch (props.draftType) {
    case 'recipe':
    case 'recipe_cook':
    case 'meal_plan':
    case 'shopping_list':
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
