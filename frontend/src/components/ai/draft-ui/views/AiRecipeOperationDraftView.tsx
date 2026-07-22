import type { AiGeneratedRecipeDraft, Ingredient } from '../../../../api/types';
import type { AiResourceOption, AiResourceOptionLoader } from '../../AiApprovalFields';
import { asNumber, asText } from '../../aiDraftValueUtils';
import { AiDraftImpactNote } from '../AiDraftImpactNote';
import { AiDraftResolvedSummary } from '../AiDraftResolvedSummary';
import { AiDraftSection } from '../AiDraftSection';
import { AiDraftSummaryCard } from '../AiDraftSummaryCard';
import { AiRecipeDraftEditorFields } from './AiRecipeDraftEditorFields';
import {
  recipeDifficultyLabel,
  recipeDraftFromRecord,
  recipeDraftSummaryItems,
} from './aiRecipeDraftViewModel';

function recordFrom(value: unknown) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function actionLabel(action: string) {
  if (action === 'update') return '修改';
  if (action === 'delete') return '删除';
  if (action === 'create') return '创建';
  return '待确认';
}

function resolvedOperationTitle(status: string, label: string) {
  if (status === 'approved') return `${label}菜谱已确认`;
  if (status === 'rejected') return '未写入的菜谱草稿';
  if (status === 'expired') return '已过期的菜谱草稿';
  return '已处理的菜谱草稿';
}

function resolvedOperationStatus(status: string): 'approved' | 'rejected' | 'expired' | 'cancelled' | 'canceled' {
  if (status === 'approved' || status === 'rejected' || status === 'expired' || status === 'cancelled' || status === 'canceled') {
    return status;
  }
  return 'expired';
}

function recipeCompareText(recipe: { title: string; servings: number | ''; difficulty: string }) {
  return [
    recipe.title,
    `${asNumber(recipe.servings)}人份`,
    recipeDifficultyLabel(recipe.difficulty),
  ].filter(Boolean).join(' · ');
}

export function AiRecipeOperationDraftView(props: {
  draft: Record<string, unknown>;
  readonly: boolean;
  status: string;
  ingredients: readonly Ingredient[];
  ingredientOptions: readonly AiResourceOption[];
  onDraftChange: (next: Record<string, unknown>) => void;
  onLoadResourceOptions: AiResourceOptionLoader;
}) {
  const action = asText(props.draft.action);
  const label = actionLabel(action);
  const payload = recordFrom(props.draft.payload);
  const before = recordFrom(props.draft.before);
  const recipe = recipeDraftFromRecord(payload, before);
  const beforeRecipe = recipeDraftFromRecord(before);
  const deleteImpact = recordFrom(before.deleteImpact);
  const mediaCount = Array.isArray(before.media_ids)
    ? before.media_ids.length
    : Array.isArray(before.mediaIds)
      ? before.mediaIds.length
      : 0;
  const updatePayload = (patch: Record<string, unknown>) => {
    props.onDraftChange({ ...props.draft, payload: { ...payload, ...patch } });
  };
  const replaceRecipePayload = (next: AiGeneratedRecipeDraft) => {
    updatePayload({
      title: next.title,
      servings: next.servings,
      prep_minutes: next.prep_minutes,
      difficulty: next.difficulty,
      ingredient_items: next.ingredient_items,
      steps: next.steps,
      tips: next.tips,
      scene_tags: next.scene_tags,
      media_ids: next.media_ids,
    });
  };

  if (props.status !== 'pending') {
    return (
      <div className="ai-recipe-editor ai-confirmation-editor ai-recipe-draft-editor">
        <AiDraftResolvedSummary
          status={resolvedOperationStatus(props.status)}
          title={resolvedOperationTitle(props.status, label)}
          summary={recipe.title || '菜谱'}
          className="ai-recipe-summary-card"
        >
          <dl className="ai-draft-summary-items">
            {recipeDraftSummaryItems(recipe).map((item) => (
              <div key={item.label} className="ai-draft-summary-item">
                <dt>{item.label}</dt>
                <dd>{item.value}</dd>
              </div>
            ))}
          </dl>
          {recipe.tips ? <p className="ai-recipe-summary-note">{recipe.tips}</p> : null}
        </AiDraftResolvedSummary>
      </div>
    );
  }

  return (
    <div className="ai-recipe-editor ai-confirmation-editor ai-recipe-draft-editor">
      <div className="ai-draft-editor-head">
        <div>
          <strong>{label}菜谱</strong>
          <span>{recipe.title || '菜谱'}</span>
        </div>
      </div>
      <AiDraftSummaryCard
        title={recipe.title || '待确认菜谱'}
        items={recipeDraftSummaryItems(recipe)}
        tone={action === 'delete' ? 'danger' : 'plan'}
        className="ai-confirmation-item ai-recipe-summary-card"
      >
        <AiDraftImpactNote tone="plan" title="确认后">
          {action === 'delete'
            ? '将删除这道菜谱，并按现有规则处理同步食物和媒体绑定。'
            : '将写入菜谱资料，并同步关联的家常菜食物资料。'}
        </AiDraftImpactNote>
      </AiDraftSummaryCard>
      {action === 'update' ? (
        <AiDraftImpactNote tone="plan" title="当前与调整后" className="ai-recipe-operation-compare">
          <p>当前：{recipeCompareText(beforeRecipe)}</p>
          <p>调整后：{recipeCompareText(recipe)}</p>
        </AiDraftImpactNote>
      ) : null}
      {action === 'delete' ? (
        <AiDraftSection title="删除确认" className="ai-confirmation-item">
          <AiDraftImpactNote tone="danger" title="删除影响" className="ai-recipe-danger-impact">
            <p>被删菜谱：{recipe.title || asText(before.title) || '当前菜谱'}</p>
            <p>同步食物：{asNumber(deleteImpact.linkedFoodCount, 0)} 个</p>
            <p>关联计划：{asNumber(deleteImpact.planItemCount, 0)} 条</p>
            <p>历史烹饪：{asNumber(deleteImpact.cookLogCount, 0)} 条</p>
            <p>媒体绑定：{asNumber(deleteImpact.mediaCount, mediaCount)} 个</p>
          </AiDraftImpactNote>
          <label className="ai-resource-field ai-confirmation-copy-field">
            <span>删除原因</span>
            <textarea
              className="text-input"
              rows={2}
              value={asText(payload.reason)}
              disabled={props.readonly}
              placeholder="可选，说明删除原因"
              onChange={(event) => updatePayload({ reason: event.target.value })}
            />
          </label>
        </AiDraftSection>
      ) : (
        <AiRecipeDraftEditorFields
          recipe={recipe}
          readonly={props.readonly}
          ingredients={props.ingredients}
          ingredientOptions={props.ingredientOptions}
          ingredientSectionTitle="食材匹配"
          onRecipeChange={replaceRecipePayload}
          onLoadResourceOptions={props.onLoadResourceOptions}
        />
      )}
    </div>
  );
}
