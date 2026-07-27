import type { AiGeneratedRecipeDraft, Difficulty, Ingredient } from '../../../../api/types';
import { RECIPE_STEP_ICON_OPTIONS } from '../../../recipes/RecipeWorkspaceOptions';
import {
  AiSearchableResourceSelect,
  ApprovalComboboxField,
  ApprovalSelectField,
} from '../../AiApprovalFields';
import type { AiResourceOption, AiResourceOptionLoader } from '../../AiApprovalFields';
import { draftNumberFromInput, draftNumberInputValue, nullableDraftNumberFromInput } from '../../aiDraftValueUtils';
import { AiDraftItemCard } from '../AiDraftItemCard';
import { AiDraftSection } from '../AiDraftSection';
import { AiDraftTagInput } from '../AiDraftTagInput';
import {
  RECIPE_DIFFICULTY_OPTIONS,
  recipeDraftUnitOptions,
  recipeIngredientUsesPresenceQuantity,
} from './aiRecipeDraftViewModel';

export function AiRecipeDraftEditorFields(props: {
  recipe: AiGeneratedRecipeDraft;
  readonly: boolean;
  ingredients: readonly Ingredient[];
  ingredientOptions: readonly AiResourceOption[];
  ingredientSectionTitle?: string;
  onRecipeChange: (next: AiGeneratedRecipeDraft) => void;
  onLoadResourceOptions: AiResourceOptionLoader;
}) {
  const updateIngredient = (index: number, patch: Partial<AiGeneratedRecipeDraft['ingredient_items'][number]>) => {
    props.onRecipeChange({
      ...props.recipe,
      ingredient_items: props.recipe.ingredient_items.map((item, itemIndex) => (itemIndex === index ? { ...item, ...patch } : item)),
    });
  };
  const updateStep = (index: number, patch: Partial<AiGeneratedRecipeDraft['steps'][number]>) => {
    props.onRecipeChange({
      ...props.recipe,
      steps: props.recipe.steps.map((step, stepIndex) => (stepIndex === index ? { ...step, ...patch } : step)),
    });
  };

  return (
    <>
      <AiDraftSection
        title="菜谱信息"
        description="用于菜谱库展示、搜索和后续餐食计划。"
        className="ai-confirmation-item"
      >
        <label className="ai-resource-field">
          <span>菜谱名</span>
          <input
            className="text-input"
            value={props.recipe.title}
            disabled={props.readonly}
            onChange={(event) => props.onRecipeChange({ ...props.recipe, title: event.target.value })}
          />
        </label>
        <div className="ai-confirmation-grid ai-confirmation-grid-three">
          <label className="ai-resource-field">
            <span>份量</span>
            <input
              className="text-input"
              type="number"
              min={1}
              value={draftNumberInputValue(props.recipe.servings, 1)}
              disabled={props.readonly}
              onChange={(event) => props.onRecipeChange({ ...props.recipe, servings: draftNumberFromInput(event.target.value) as number })}
            />
          </label>
          <label className="ai-resource-field">
            <span>时间（分钟）</span>
            <input
              className="text-input"
              type="number"
              min={0}
              value={draftNumberInputValue(props.recipe.prep_minutes, 0)}
              disabled={props.readonly}
              onChange={(event) => props.onRecipeChange({ ...props.recipe, prep_minutes: draftNumberFromInput(event.target.value) as number })}
            />
          </label>
          <ApprovalSelectField
            label="难度"
            value={props.recipe.difficulty}
            disabled={props.readonly}
            options={RECIPE_DIFFICULTY_OPTIONS}
            icon="difficulty"
            onChange={(difficulty) => props.onRecipeChange({ ...props.recipe, difficulty: difficulty as Difficulty })}
          />
        </div>
      </AiDraftSection>

      <AiDraftSection
        title={props.ingredientSectionTitle ?? '食材'}
        description={`${props.recipe.ingredient_items.length} 种食材，必须绑定到家庭食材库。`}
        className="ai-confirmation-item"
        action={props.readonly ? null : (
          <button
            className="ghost-button ai-draft-add-button"
            type="button"
            onClick={() => props.onRecipeChange({
              ...props.recipe,
              ingredient_items: [...props.recipe.ingredient_items, { ingredient_id: null, ingredient_name: '', quantity: 1, unit: '份', note: '' }],
            })}
          >
            添加食材
          </button>
        )}
      >
        {props.recipe.ingredient_items.map((item, index) => {
          const usesPresenceQuantity = recipeIngredientUsesPresenceQuantity(item, props.ingredients);
          return (
            <AiDraftItemCard
              key={`${item.ingredient_name}-${index}`}
              title={`食材 ${index + 1}`}
              summary={item.ingredient_name || '请从食材库选择'}
              className={`ai-recipe-ingredient-card${item.ingredient_id ? '' : ' is-unbound'}`}
              footer={!props.readonly && props.recipe.ingredient_items.length > 1 ? (
                <button
                  className="ghost-button ai-draft-remove-button"
                  type="button"
                  onClick={() => props.onRecipeChange({
                    ...props.recipe,
                    ingredient_items: props.recipe.ingredient_items.filter((_, itemIndex) => itemIndex !== index),
                  })}
                >
                  删除食材
                </button>
              ) : undefined}
            >
              <AiSearchableResourceSelect
                kind="ingredient"
                label={`食材 ${index + 1}`}
                value={item.ingredient_id ?? ''}
                selectedLabel={item.ingredient_name}
                placeholder="从食材库选择"
                disabled={props.readonly}
                selectedOption={props.ingredientOptions.find((option) => option.id === item.ingredient_id || option.label === item.ingredient_name) ?? null}
                loadOptions={props.onLoadResourceOptions}
                onSelect={(option) => updateIngredient(index, {
                  ingredient_id: option.id,
                  ingredient_name: option.label,
                  unit: option.unit || item.unit || '',
                })}
              />
              {!item.ingredient_id ? (
                <p className="ai-recipe-binding-warning">
                  未绑定到食材库。请先选择已有食材；如果家里还没有这个食材，应先生成食材档案草稿。
                </p>
              ) : null}
              {usesPresenceQuantity ? (
                <div className="recipe-editor-ingredient-presence-note">用量写在步骤或备注里</div>
              ) : (
                <div className="ai-confirmation-grid ai-confirmation-grid-compact">
                  <label className="ai-resource-field">
                    <span>数量</span>
                    <input
                      className="text-input"
                      type="number"
                      min={0.1}
                      step={0.1}
                      value={draftNumberInputValue(item.quantity)}
                      disabled={props.readonly}
                      onChange={(event) => updateIngredient(index, { quantity: draftNumberFromInput(event.target.value) as number })}
                    />
                  </label>
                  <ApprovalComboboxField
                    label="单位"
                    value={item.unit ?? ''}
                    disabled={props.readonly}
                    options={recipeDraftUnitOptions(item.unit ?? '')}
                    placeholder="选择单位"
                    icon="step"
                    onChange={(unit) => updateIngredient(index, { unit })}
                  />
                </div>
              )}
              <label className="ai-resource-field">
                <span>处理备注</span>
                <input
                  className="text-input"
                  value={item.note}
                  disabled={props.readonly}
                  placeholder="例如切块、提前浸泡"
                  onChange={(event) => updateIngredient(index, { note: event.target.value })}
                />
              </label>
            </AiDraftItemCard>
          );
        })}
      </AiDraftSection>

      <AiDraftSection
        title="烹饪步骤"
        description={`${props.recipe.steps.length} 步，标题或说明至少填写一项。`}
        className="ai-confirmation-item"
        action={props.readonly ? null : (
          <button
            className="ghost-button ai-draft-add-button"
            type="button"
            onClick={() => props.onRecipeChange({
              ...props.recipe,
              steps: [...props.recipe.steps, { title: `步骤 ${props.recipe.steps.length + 1}`, text: '', icon: 'pan', summary: '', estimated_minutes: 5, tip: '', key_points: [] }],
            })}
          >
            添加步骤
          </button>
        )}
      >
        {props.recipe.steps.map((step, index) => (
          <AiDraftItemCard
            key={`${step.title}-${index}`}
            title={`步骤 ${index + 1}`}
            summary={step.summary || step.text || '待补充操作说明'}
            className="ai-recipe-step-card"
            footer={!props.readonly && props.recipe.steps.length > 1 ? (
              <button
                className="ghost-button ai-draft-remove-button"
                type="button"
                onClick={() => props.onRecipeChange({
                  ...props.recipe,
                  steps: props.recipe.steps.filter((_, stepIndex) => stepIndex !== index),
                })}
              >
                删除步骤
              </button>
            ) : undefined}
          >
            <label className="ai-resource-field">
              <span>步骤 {index + 1}</span>
              <input
                className="text-input ai-confirmation-title-input"
                value={step.title}
                disabled={props.readonly}
                placeholder={`步骤 ${index + 1}`}
                onChange={(event) => updateStep(index, { title: event.target.value })}
              />
            </label>
            <div className="ai-confirmation-grid ai-confirmation-grid-three">
              <label className="ai-resource-field">
                <span>摘要</span>
                <input
                  className="text-input"
                  value={step.summary ?? ''}
                  disabled={props.readonly}
                  placeholder="简短概括"
                  onChange={(event) => updateStep(index, { summary: event.target.value })}
                />
              </label>
              <label className="ai-resource-field">
                <span>预计用时（分钟）</span>
                <input
                  className="text-input"
                  type="number"
                  min={1}
                  value={draftNumberInputValue(step.estimated_minutes)}
                  disabled={props.readonly}
                  placeholder="分钟"
                  onChange={(event) => updateStep(index, { estimated_minutes: nullableDraftNumberFromInput(event.target.value) })}
                />
              </label>
              <ApprovalSelectField
                label="步骤图标"
                value={step.icon ?? 'pan'}
                disabled={props.readonly}
                options={RECIPE_STEP_ICON_OPTIONS}
                icon="step"
                onChange={(icon) => updateStep(index, { icon })}
              />
            </div>
            <label className="ai-resource-field ai-confirmation-copy-field">
              <span>步骤说明</span>
              <textarea
                className="text-input"
                rows={3}
                value={step.text}
                disabled={props.readonly}
                placeholder="详细说明操作方法"
                onChange={(event) => updateStep(index, { text: event.target.value })}
              />
            </label>
            <AiDraftTagInput
              label="关键点"
              values={step.key_points ?? []}
              disabled={props.readonly}
              placeholder="火候、状态、注意点"
              className="ai-resource-field ai-tag-input-field"
              onChange={(keyPoints) => updateStep(index, { key_points: keyPoints })}
            />
          </AiDraftItemCard>
        ))}
      </AiDraftSection>

      <AiDraftSection
        title="补充信息"
        description="用于后续筛选和家庭做菜备注。"
        className="ai-confirmation-item"
      >
        <AiDraftTagInput
          label="场景标签"
          values={props.recipe.scene_tags ?? []}
          disabled={props.readonly}
          placeholder="家常菜、快手菜"
          className="ai-resource-field ai-tag-input-field"
          onChange={(sceneTags) => props.onRecipeChange({ ...props.recipe, scene_tags: sceneTags })}
        />
        <label className="ai-resource-field ai-confirmation-copy-field">
          <span>小贴士</span>
          <textarea
            className="text-input"
            rows={2}
            value={props.recipe.tips}
            disabled={props.readonly}
            placeholder="补充火候、替换食材等提示"
            onChange={(event) => props.onRecipeChange({ ...props.recipe, tips: event.target.value })}
          />
        </label>
      </AiDraftSection>
    </>
  );
}
