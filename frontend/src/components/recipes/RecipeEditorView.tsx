import type { Dispatch, FormEvent, SetStateAction } from 'react';
import type { Difficulty, Ingredient, MediaAsset } from '../../api/types';
import type { AiRenderPayload } from '../../lib/aiImages';
import { ActionButton, WorkspaceSubpageShell } from '../ui-kit';
import {
  MAX_STEP_KEY_POINTS,
  RECIPE_STEP_ICON_OPTIONS,
  SHOPPING_UNIT_OPTIONS,
} from './RecipeWorkspaceOptions';
import { RecipeDishIllustration, RecipeUiIcon, getRecipeVisualTone } from './RecipeWorkspaceCards';
import {
  createEmptyRecipeStepDraft,
  getRecipeShoppingRequirement,
  getRecipeStepIconName,
  stripRecipeIngredientRequirementNote,
  type RecipeDraftGenerationStage,
  type RecipeDraftIngredient,
  type RecipeFormState,
  type RecipeShoppingRequirement,
  type RecipeStepDraft,
} from './RecipeWorkspaceModel';
import { DIFFICULTY_LABELS } from './workspaceModel';

type RecipeEditorCompletionItem = {
  label: string;
  done: boolean;
};

type RecipeEditorSummaryItem = {
  label: string;
  value: string;
};

type RecipeImageState = {
  isGenerating: boolean;
  errorMessage: string | null;
};

type RecipeEditorViewProps = {
  isEditing: boolean;
  isRecipeAiApplied: boolean;
  selectedRecipeId: string | null;
  form: RecipeFormState;
  setForm: Dispatch<SetStateAction<RecipeFormState>>;
  ingredientRows: RecipeDraftIngredient[];
  ingredients: Ingredient[];
  sceneTagDraft: string;
  setSceneTagDraft: Dispatch<SetStateAction<string>>;
  sceneSelectOptions: string[];
  editorSceneTags: string[];
  visibleStepTips: Record<string, boolean>;
  stepKeyPointSlots: Record<string, number>;
  editorCoverUrl: string | null | undefined;
  editorReferenceUrl: string | null | undefined;
  editorGeneratedUrl: string | null | undefined;
  editorCoverAsset: MediaAsset | undefined;
  editorIngredientCount: number;
  editorStepCount: number;
  editorCompletionItems: RecipeEditorCompletionItem[];
  editorCompletionPercent: number;
  aiSourceSummary: RecipeEditorSummaryItem[];
  recipeDraftError: string | null;
  isRecipeDraftBusy: boolean;
  recipeImageState: RecipeImageState;
  recipeDraftGenerationStage: RecipeDraftGenerationStage;
  recipeDraftButtonLabel: string;
  recipeImagePayload: AiRenderPayload;
  submitDisabled: boolean;
  isCreatingRecipe?: boolean;
  isUpdatingRecipe?: boolean;
  isDeletingRecipe?: boolean;
  onBack: () => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onDelete: () => Promise<void> | void;
  onOpenDraftDialog: () => void;
  updateIngredientRow: (id: string, key: 'ingredient_id' | 'quantity' | 'unit' | 'note', value: string) => void;
  updateIngredientNote: (id: string, value: string) => void;
  updateIngredientRequirement: (id: string, requirement: RecipeShoppingRequirement) => void;
  addIngredientRow: () => void;
  removeIngredientRow: (id: string) => void;
  updateStepDraft: (stepId: string, patch: Partial<RecipeStepDraft>) => void;
  getStepKeyPointValues: (step: RecipeStepDraft) => string[];
  getStepKeyPointRowCount: (step: RecipeStepDraft) => number;
  addStepTip: (stepId: string) => void;
  addStepKeyPoint: (step: RecipeStepDraft) => void;
  updateStepKeyPoint: (step: RecipeStepDraft, index: number, value: string) => void;
  removeStepKeyPoint: (step: RecipeStepDraft, index: number) => void;
  commitSceneTagDraft: () => void;
  handleRecipeImageUpload: (files: FileList | null) => Promise<void>;
  handleRecipeImageGenerate: (mode: 'reference' | 'text') => Promise<void>;
  resetRecipeImageInput: () => void;
};

export function RecipeEditorView({
  isEditing,
  isRecipeAiApplied,
  selectedRecipeId,
  form,
  setForm,
  ingredientRows,
  ingredients,
  sceneTagDraft,
  setSceneTagDraft,
  sceneSelectOptions,
  editorSceneTags,
  visibleStepTips,
  stepKeyPointSlots,
  editorCoverUrl,
  editorReferenceUrl,
  editorGeneratedUrl,
  editorCoverAsset,
  editorIngredientCount,
  editorStepCount,
  editorCompletionItems,
  editorCompletionPercent,
  aiSourceSummary,
  recipeDraftError,
  isRecipeDraftBusy,
  recipeImageState,
  recipeDraftGenerationStage,
  recipeDraftButtonLabel,
  recipeImagePayload,
  submitDisabled,
  isCreatingRecipe,
  isUpdatingRecipe,
  isDeletingRecipe,
  onBack,
  onSubmit,
  onDelete,
  onOpenDraftDialog,
  updateIngredientRow,
  updateIngredientNote,
  updateIngredientRequirement,
  addIngredientRow,
  removeIngredientRow,
  updateStepDraft,
  getStepKeyPointValues,
  getStepKeyPointRowCount,
  addStepTip,
  addStepKeyPoint,
  updateStepKeyPoint,
  removeStepKeyPoint,
  commitSceneTagDraft,
  handleRecipeImageUpload,
  handleRecipeImageGenerate,
  resetRecipeImageInput,
}: RecipeEditorViewProps) {
  return (
        <WorkspaceSubpageShell className="recipe-editor-subpage">
          <div className="recipe-editor-topbar">
            <button className="workspace-back-link recipe-detail-back-link" type="button" onClick={() => onBack()}>
              <RecipeUiIcon name="chevronLeft" />
              {isEditing ? '返回详情' : '返回菜谱'}
            </button>
          </div>
          <div className="recipe-editor-title-block">
            <p className="eyebrow">菜谱</p>
            <h2>{isEditing ? '编辑菜谱' : '新增菜谱'}</h2>
            <p>把标题、用料、步骤和图片放在同一个录入工作台里。</p>
          </div>

          <form className={isRecipeAiApplied ? 'recipe-editor-workbench ai-applied' : 'recipe-editor-workbench'} onSubmit={onSubmit}>
            <main className="recipe-editor-main-column">
              <section className="recipe-editor-card">
                <div className="recipe-editor-card-head">
                  <span className="recipe-editor-section-index">1</span>
                  <h3>基础信息</h3>
                </div>
                <div className="recipe-editor-basic-grid">
                  <label>
                    <span>菜谱标题</span>
                    <input className="text-input" value={form.title} onChange={(event) => setForm({ ...form, title: event.target.value })} />
                  </label>
                  <label>
                    <span>份量</span>
                    <select className="text-input" value={form.servings} onChange={(event) => setForm({ ...form, servings: event.target.value })}>
                      {[1, 2, 3, 4, 5, 6, 8].map((serving) => (
                        <option key={serving} value={String(serving)}>{serving} 人份</option>
                      ))}
                    </select>
                  </label>
                  <label>
                    <span>准备时长（分钟）</span>
                    <input className="text-input" type="number" min="1" value={form.prepMinutes} onChange={(event) => setForm({ ...form, prepMinutes: event.target.value })} />
                  </label>
                  <label>
                    <span>难度</span>
                    <select className="text-input" value={form.difficulty} onChange={(event) => setForm({ ...form, difficulty: event.target.value as Difficulty })}>
                      <option value="easy">简单</option>
                      <option value="medium">中等</option>
                      <option value="hard">复杂</option>
                    </select>
                  </label>
                  <label className="recipe-editor-tips-field">
                    <span>技巧 / 说明（选填）</span>
                    <textarea className="text-input" rows={3} value={form.tips} onChange={(event) => setForm({ ...form, tips: event.target.value })} />
                    <small>{form.tips.length}/200</small>
                  </label>
                </div>
              </section>

              <section className="recipe-editor-card">
                <div className="recipe-editor-card-head">
                  <span className="recipe-editor-section-index">2</span>
                  <h3>原料清单</h3>
                  <ActionButton tone="secondary" size="compact" type="button" onClick={addIngredientRow}>
                    <RecipeUiIcon name="plus" />
                    添加原料
                  </ActionButton>
                </div>
                <div className="recipe-editor-ingredient-table">
                  <div className="recipe-editor-ingredient-head">
                    <span />
                    <span>原料</span>
                    <span>数量</span>
                    <span>单位</span>
                    <span>类型</span>
                    <span>备注（选填）</span>
                    <span>操作</span>
                  </div>
                  {ingredientRows.map((item, index) => (
                    <div key={item.id} className="recipe-editor-ingredient-row">
                      <span className="recipe-editor-drag-handle">::</span>
                      <select className="text-input" value={item.ingredient_id ?? ''} onChange={(event) => updateIngredientRow(item.id, 'ingredient_id', event.target.value)}>
                        <option value="">{item.ingredient_name || `选择原料 ${index + 1}`}</option>
                        {ingredients.map((ingredient) => (
                          <option key={ingredient.id} value={ingredient.id}>
                            {ingredient.name}
                          </option>
                        ))}
                      </select>
                      <input className="text-input" type="number" min="0.1" step="0.1" value={item.quantity} onChange={(event) => updateIngredientRow(item.id, 'quantity', event.target.value)} />
                      <select className="text-input" value={item.unit} onChange={(event) => updateIngredientRow(item.id, 'unit', event.target.value)}>
                        {[...new Set([item.unit, ...SHOPPING_UNIT_OPTIONS])].filter(Boolean).map((unit) => (
                          <option key={unit} value={unit}>{unit}</option>
                        ))}
                      </select>
                      <select
                        className="text-input"
                        value={getRecipeShoppingRequirement(item)}
                        onChange={(event) => updateIngredientRequirement(item.id, event.target.value as RecipeShoppingRequirement)}
                      >
                        <option value="required">必须</option>
                        <option value="optional">可选</option>
                      </select>
                      <input
                        className="text-input"
                        value={stripRecipeIngredientRequirementNote(item.note)}
                        placeholder="处理备注"
                        onChange={(event) => updateIngredientNote(item.id, event.target.value)}
                      />
                      <button className="recipe-editor-icon-button" type="button" onClick={() => removeIngredientRow(item.id)} aria-label={`删除原料 ${index + 1}`}>
                        <RecipeUiIcon name="minus" />
                      </button>
                    </div>
                  ))}
                </div>
              </section>

              <section className="recipe-editor-card">
                <div className="recipe-editor-card-head">
                  <span className="recipe-editor-section-index">3</span>
                  <h3>步骤</h3>
                  <ActionButton tone="secondary" size="compact" type="button" onClick={() => setForm({ ...form, steps: [...form.steps, createEmptyRecipeStepDraft()] })}>
                    <RecipeUiIcon name="plus" />
                    添加步骤
                  </ActionButton>
                </div>
                <div className="recipe-editor-step-list">
                  {form.steps.map((step, index) => {
                    const showTip = Boolean(step.tip.trim()) || Boolean(visibleStepTips[step.id]);
                    const keyPointRowCount = getStepKeyPointRowCount(step);
                    const keyPointRows = Array.from({ length: keyPointRowCount }, (_, rowIndex) => getStepKeyPointValues(step)[rowIndex] ?? '');
                    return (
                      <div key={step.id} className="recipe-editor-step-card">
                        <span className="recipe-editor-step-index">{index + 1}</span>
                        <div className="recipe-editor-step-fields">
                          <label>
                            <span>图标</span>
                            <span className="recipe-editor-icon-select">
                              <RecipeUiIcon name={getRecipeStepIconName(step.icon)} />
                              <select
                                className="text-input"
                                value={step.icon}
                                onChange={(event) => updateStepDraft(step.id, { icon: event.target.value })}
                              >
                                {RECIPE_STEP_ICON_OPTIONS.map((option) => (
                                  <option key={option.value} value={option.value}>
                                    {option.label}
                                  </option>
                                ))}
                              </select>
                            </span>
                          </label>
                          <label>
                            <span>预计用时（分钟）</span>
                            <input
                              className="text-input"
                              type="number"
                              min="0"
                              step="1"
                              value={step.estimatedMinutes}
                              onChange={(event) => updateStepDraft(step.id, { estimatedMinutes: event.target.value })}
                            />
                          </label>
                          <label>
                            <span>步骤名称</span>
                            <input
                              className="text-input"
                              value={step.title}
                              placeholder="例如：冷蒸三文鱼"
                              onChange={(event) => updateStepDraft(step.id, { title: event.target.value })}
                            />
                          </label>
                          <label>
                            <span>一句话说明</span>
                            <input
                              className="text-input"
                              value={step.summary}
                              placeholder="例如：蒸出嫩滑口感"
                              onChange={(event) => updateStepDraft(step.id, { summary: event.target.value })}
                            />
                          </label>

                          <section className="recipe-editor-step-detail recipe-editor-step-wide">
                            <span className="recipe-editor-step-detail-icon"><RecipeUiIcon name="clipboard" /></span>
                            <label>
                              <span>详细操作</span>
                              <textarea
                                className="text-input"
                                rows={3}
                                value={step.text}
                                placeholder="写清楚处理、火候和时间。"
                                onChange={(event) => updateStepDraft(step.id, { text: event.target.value })}
                              />
                            </label>
                          </section>

                          <section className="recipe-editor-step-detail recipe-editor-step-wide">
                            <span className="recipe-editor-step-detail-icon"><RecipeUiIcon name="sparkle" /></span>
                            <div className="recipe-editor-step-extra-head">
                              <div>
                                <strong>烹饪小贴士（选填）</strong>
                                <small>仅可添加 1 条</small>
                              </div>
                              {!showTip && (
                                <button type="button" onClick={() => addStepTip(step.id)}>
                                  <RecipeUiIcon name="plus" />
                                  添加小贴士
                                </button>
                              )}
                            </div>
                            {showTip && (
                              <textarea
                                className="text-input"
                                rows={2}
                                value={step.tip}
                                placeholder="例如：出锅前补一小勺热油，香气更明显。"
                                onChange={(event) => updateStepDraft(step.id, { tip: event.target.value })}
                              />
                            )}
                          </section>

                          <section className="recipe-editor-step-detail recipe-editor-step-wide">
                            <span className="recipe-editor-step-detail-icon"><RecipeUiIcon name="star" /></span>
                            <div className="recipe-editor-step-extra-head">
                              <div>
                                <strong>关键要点（选填）</strong>
                                <small>最多 3 条，每条一句</small>
                              </div>
                              {keyPointRowCount < MAX_STEP_KEY_POINTS && (
                                <button type="button" onClick={() => addStepKeyPoint(step)}>
                                  <RecipeUiIcon name="plus" />
                                  添加要点
                                </button>
                              )}
                            </div>
                            <div className="recipe-editor-keypoint-list">
                              {keyPointRows.map((point, pointIndex) => (
                                <div key={`${step.id}-keypoint-${pointIndex}`} className="recipe-editor-keypoint-row">
                                  <span className="recipe-editor-drag-handle">::</span>
                                  <input
                                    className="text-input"
                                    value={point}
                                    placeholder={`要点 ${pointIndex + 1}`}
                                    onChange={(event) => updateStepKeyPoint(step, pointIndex, event.target.value)}
                                  />
                                  <button type="button" onClick={() => removeStepKeyPoint(step, pointIndex)} aria-label={`删除要点 ${pointIndex + 1}`}>
                                    <RecipeUiIcon name="minus" />
                                  </button>
                                </div>
                              ))}
                              {keyPointRowCount === 0 && (
                                <button className="recipe-editor-keypoint-placeholder" type="button" onClick={() => addStepKeyPoint(step)}>
                                  还可添加 3 条（最多 3 条）
                                </button>
                              )}
                              {keyPointRowCount > 0 && keyPointRowCount < MAX_STEP_KEY_POINTS && (
                                <button className="recipe-editor-keypoint-placeholder" type="button" onClick={() => addStepKeyPoint(step)}>
                                  还可添加 {MAX_STEP_KEY_POINTS - keyPointRowCount} 条（最多 3 条）
                                </button>
                              )}
                            </div>
                          </section>
                        </div>
                        <button
                          className="recipe-editor-icon-button"
                          type="button"
                          onClick={() => setForm({ ...form, steps: form.steps.length > 1 ? form.steps.filter((item) => item.id !== step.id) : form.steps })}
                          aria-label={`删除步骤 ${index + 1}`}
                        >
                          <RecipeUiIcon name="minus" />
                        </button>
                      </div>
                    );
                  })}
                </div>
              </section>

              <section className="recipe-editor-card recipe-editor-cover-card">
                <div className="recipe-editor-card-head">
                  <span className="recipe-editor-section-index">4</span>
                  <h3>菜谱封面</h3>
                </div>
                <div className="recipe-editor-cover-grid">
                  <div className="recipe-editor-cover-preview">
                    {editorCoverUrl ? (
                      <img src={editorCoverUrl} alt={form.title || '菜谱封面'} />
                    ) : (
                      <RecipeDishIllustration title={form.title || '菜谱封面'} tone={getRecipeVisualTone(selectedRecipeId ?? (form.title || 'draft'))} />
                    )}
                  </div>
                  <div className="recipe-editor-cover-workspace">
                    <div className="recipe-editor-cover-toolbar">
                      <div>
                        <h4>菜谱封面</h4>
                        <p>可直接基于菜谱信息生成，也可以上传参考图后生成统一风格主图。</p>
                      </div>
                      <div className="recipe-editor-cover-actions">
                        <button
                          className="ghost-button"
                          type="button"
                          onClick={() => void handleRecipeImageGenerate('text')}
                          disabled={recipeImageState.isGenerating}
                        >
                          {recipeImageState.isGenerating && !form.images.referenceAsset ? '生成中...' : '基于信息生成主图'}
                        </button>
                        <label className={recipeImageState.isGenerating ? 'ghost-button disabled' : 'ghost-button'}>
                          <input
                            type="file"
                            accept="image/*,.svg"
                            capture="environment"
                            disabled={recipeImageState.isGenerating}
                            onChange={(event) => {
                              void handleRecipeImageUpload(event.target.files);
                              event.currentTarget.value = '';
                            }}
                          />
                          上传图片生成
                        </label>
                        {form.images.referenceAsset && (
                          <button
                            className="ghost-button"
                            type="button"
                            onClick={() => void handleRecipeImageGenerate('reference')}
                            disabled={recipeImageState.isGenerating}
                          >
                            {recipeImageState.isGenerating ? '生成中...' : '基于参考图生成'}
                          </button>
                        )}
                        <button className="ghost-button" type="button" onClick={resetRecipeImageInput} disabled={recipeImageState.isGenerating}>
                          清空图片
                        </button>
                      </div>
                    </div>

                    <div className={editorReferenceUrl ? 'recipe-editor-cover-result-grid has-reference' : 'recipe-editor-cover-result-grid'}>
                      {editorReferenceUrl && (
                        <label className="recipe-editor-cover-result recipe-editor-cover-upload-card">
                          <input
                            type="file"
                            accept="image/*,.svg"
                            capture="environment"
                            disabled={recipeImageState.isGenerating}
                            onChange={(event) => {
                              void handleRecipeImageUpload(event.target.files);
                              event.currentTarget.value = '';
                            }}
                          />
                          <div className="recipe-editor-cover-result-head">
                            <span>参考图</span>
                            <small>{recipeImageState.isGenerating ? '正在生成' : '点按更换'}</small>
                          </div>
                          <img src={editorReferenceUrl} alt={`${form.title || '菜谱'}参考图`} />
                        </label>
                      )}
                      <article className="recipe-editor-cover-result">
                        <div className="recipe-editor-cover-result-head">
                          <span>AI 主图</span>
                          <small>{form.images.generatedAsset ? '已生成' : recipeImageState.isGenerating ? '生成中' : '未生成'}</small>
                        </div>
                        {editorGeneratedUrl ? (
                          <img src={editorGeneratedUrl} alt={form.title || '菜谱封面'} />
                        ) : (
                          <div className="recipe-editor-cover-empty">
                            {recipeImageState.isGenerating ? <span className="image-composer-loading-surface" aria-hidden="true" /> : <RecipeUiIcon name="image" />}
                            <strong>{recipeImageState.isGenerating ? 'AI 正在生成封面' : '还没有 AI 主图'}</strong>
                            <p>{form.images.referenceAsset ? '参考图已保留，可以重试生成主图。' : '先用文字信息生成，或上传参考图生成。'}</p>
                          </div>
                        )}
                      </article>
                    </div>
                    {recipeImageState.errorMessage && <span className="image-composer-error">{recipeImageState.errorMessage}</span>}
                    <p className="recipe-editor-cover-hint">推荐尺寸：4:3，JPG/PNG，30 MB 以内。</p>
                  </div>
                </div>
              </section>
            </main>

            <aside className="recipe-editor-side-column">
              <section className="recipe-editor-side-card recipe-ai-draft-panel">
                <div className="workspace-action-rail-copy">
                  <p className="eyebrow">AI 生成</p>
                  <h3>自动补全菜谱</h3>
                  <p className="subtle">基于左侧已填写内容生成完整菜谱，保存前仍可继续编辑。</p>
                </div>
                {recipeDraftError ? <p className="form-error">{recipeDraftError}</p> : null}
                <ActionButton
                  tone="secondary"
                  type="button"
                  onClick={() => onOpenDraftDialog()}
                  disabled={isRecipeDraftBusy || recipeImageState.isGenerating}
                >
                  {recipeImageState.isGenerating && recipeDraftGenerationStage === 'idle' ? '正在生成封面' : recipeDraftButtonLabel}
                </ActionButton>
              </section>
              <section className="recipe-editor-side-card recipe-editor-summary-card">
                <div className="recipe-editor-summary-head">
                  <div>
                    <h3>实时摘要</h3>
                    <p className="subtle">{isEditing ? '根据当前表单内容预览' : '保存后进入菜谱工作台'}</p>
                  </div>
                  <span><RecipeUiIcon name="check" /> 表单实时更新</span>
                </div>
                <div className="recipe-editor-live-preview">
                  {editorCoverUrl ? <img src={editorCoverUrl} alt={form.title || '菜谱封面'} /> : <RecipeDishIllustration title={form.title || '菜谱封面'} tone={getRecipeVisualTone(selectedRecipeId ?? (form.title || 'draft'))} />}
                  <div>
                    <strong>{form.title.trim() || '未命名菜谱'}</strong>
                    <p>{form.tips.trim() || '填写技巧说明后，会在这里看到摘要。'}</p>
                  </div>
                </div>
                <div className="recipe-editor-summary-list">
                  <div><span><RecipeUiIcon name="users" /></span><small>份量</small><strong>{form.servings || '2'} 人份</strong></div>
                  <div><span><RecipeUiIcon name="basket" /></span><small>原料</small><strong>{editorIngredientCount} 项</strong></div>
                  <div><span><RecipeUiIcon name="clipboard" /></span><small>步骤</small><strong>{editorStepCount} 步</strong></div>
                  <div><span><RecipeUiIcon name="image" /></span><small>图片</small><strong>{editorCoverAsset ? '已有封面' : '暂未配图'}</strong></div>
                </div>
                <div className="recipe-editor-submit-stack">
                  <ActionButton tone="primary" type="submit" disabled={submitDisabled}>
                    {isCreatingRecipe || isUpdatingRecipe ? '保存中...' : recipeImageState.isGenerating ? '生成封面中...' : '保存菜谱'}
                  </ActionButton>
                  {isEditing && (
                    <ActionButton tone="secondary" type="button" onClick={onBack}>
                      预览菜谱
                    </ActionButton>
                  )}
                  {isEditing && selectedRecipeId && (
                    <ActionButton tone="tertiary" type="button" onClick={() => void onDelete()} disabled={isDeletingRecipe}>
                      {isDeletingRecipe ? '删除中...' : '删除菜谱'}
                    </ActionButton>
                  )}
                  <ActionButton tone="secondary" type="button" onClick={() => onBack()}>
                    取消
                  </ActionButton>
                </div>
              </section>

              <section className="recipe-editor-side-card recipe-editor-completion-card">
                <div className="recipe-editor-completion-head">
                  <h3>完成度</h3>
                  <strong>{editorCompletionPercent}%</strong>
                </div>
                <div className="recipe-editor-progress-track">
                  <span style={{ width: `${editorCompletionPercent}%` }} />
                </div>
                <div className="recipe-editor-completion-list">
                  {editorCompletionItems.map((item) => (
                    <span key={item.label} className={item.done ? 'done' : ''}>
                      <RecipeUiIcon name="check" />
                      {item.label}
                    </span>
                  ))}
                </div>
              </section>
            </aside>
          </form>
        </WorkspaceSubpageShell>

  );
}
