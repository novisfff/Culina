import type { AiGeneratedRecipeDraft, Ingredient } from '../../../../api/types';
import type { AiResourceOption, AiResourceOptionLoader } from '../../AiApprovalFields';
import { AiDraftImpactNote } from '../AiDraftImpactNote';
import { AiDraftResolvedSummary } from '../AiDraftResolvedSummary';
import { AiDraftSummaryCard } from '../AiDraftSummaryCard';
import { AiRecipeDraftEditorFields } from './AiRecipeDraftEditorFields';
import { recipeDraftSummaryItems } from './aiRecipeDraftViewModel';

function resolvedRecipeTitle(status: string) {
  if (status === 'approved') return '已创建菜谱';
  if (status === 'rejected') return '未写入的菜谱草稿';
  if (status === 'expired') return '已过期的菜谱草稿';
  return '已处理的菜谱草稿';
}

function resolvedRecipeStatus(status: string): 'approved' | 'rejected' | 'expired' | 'cancelled' | 'canceled' {
  if (status === 'approved' || status === 'rejected' || status === 'expired' || status === 'cancelled' || status === 'canceled') {
    return status;
  }
  return 'expired';
}

export function AiGeneratedRecipeDraftView(props: {
  recipe: AiGeneratedRecipeDraft;
  readonly: boolean;
  status: string;
  ingredients: readonly Ingredient[];
  ingredientOptions: readonly AiResourceOption[];
  onRecipeChange: (next: AiGeneratedRecipeDraft) => void;
  onLoadResourceOptions: AiResourceOptionLoader;
}) {
  const summaryItems = recipeDraftSummaryItems(props.recipe);

  if (props.status !== 'pending') {
    return (
      <div className="ai-recipe-editor ai-confirmation-editor ai-recipe-draft-editor">
        <AiDraftResolvedSummary
          status={resolvedRecipeStatus(props.status)}
          title={resolvedRecipeTitle(props.status)}
          summary={props.recipe.title || '未命名菜谱'}
          className="ai-recipe-summary-card"
        >
          <dl className="ai-draft-summary-items">
            {summaryItems.map((item) => (
              <div key={item.label} className="ai-draft-summary-item">
                <dt>{item.label}</dt>
                <dd>{item.value}</dd>
              </div>
            ))}
          </dl>
          {props.recipe.tips ? <p className="ai-recipe-summary-note">{props.recipe.tips}</p> : null}
        </AiDraftResolvedSummary>
      </div>
    );
  }

  return (
    <div className="ai-recipe-editor ai-confirmation-editor ai-recipe-draft-editor">
      <div className="ai-draft-editor-head">
        <div>
          <strong>菜谱草稿</strong>
          <span>{props.recipe.title || '未命名菜谱'}</span>
        </div>
      </div>
      <AiDraftSummaryCard
        title={props.recipe.title || '菜谱草稿'}
        items={summaryItems}
        className="ai-confirmation-item ai-recipe-summary-card"
      >
        <AiDraftImpactNote tone="plan" title="确认后">
          将创建这道菜谱，并同步关联的家常菜食物资料。
        </AiDraftImpactNote>
      </AiDraftSummaryCard>
      <AiRecipeDraftEditorFields
        recipe={props.recipe}
        readonly={props.readonly}
        ingredients={props.ingredients}
        ingredientOptions={props.ingredientOptions}
        onRecipeChange={props.onRecipeChange}
        onLoadResourceOptions={props.onLoadResourceOptions}
      />
    </div>
  );
}
