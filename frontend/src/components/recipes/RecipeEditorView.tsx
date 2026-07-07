import { useEffect, useMemo, useRef, useState, type Dispatch, type FormEvent, type SetStateAction } from 'react';
import type { Difficulty, Ingredient, MediaAsset } from '../../api/types';
import { resolveAssetUrl } from '../../lib/assets';
import { MediaWithPlaceholder } from '../MediaPlaceholder';
import { useIngredientResourceSearch } from '../../hooks/useIngredientResourceSearch';
import { ActionButton, DropdownSelect, ImageComposer, QuantityUnitField, SearchableResourceSelect, WorkspaceSubpageShell } from '../ui-kit';
import {
  MAX_STEP_KEY_POINTS,
  RECIPE_STEP_ICON_OPTIONS,
  SHOPPING_UNIT_OPTIONS,
} from './RecipeWorkspaceOptions';
import { RecipeUiIcon } from './RecipeWorkspaceCards';
import {
  createEmptyRecipeStepDraft,
  getRecipeShoppingRequirement,
  getRecipeStepIconName,
  isPresenceOnlyRecipeIngredient,
  stripRecipeIngredientRequirementNote,
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

const SERVING_OPTIONS = [1, 2, 3, 4, 5, 6, 8].map((serving) => ({
  value: String(serving),
  label: `${serving} 人份`,
}));

const DIFFICULTY_OPTIONS: Array<{ value: Difficulty; label: string }> = [
  { value: 'easy', label: DIFFICULTY_LABELS.easy },
  { value: 'medium', label: DIFFICULTY_LABELS.medium },
  { value: 'hard', label: DIFFICULTY_LABELS.hard },
];

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
  editorCoverUrl: string | null | undefined;
  editorCoverAsset: MediaAsset | undefined;
  editorIngredientCount: number;
  editorStepCount: number;
  editorCompletionItems: RecipeEditorCompletionItem[];
  editorCompletionPercent: number;
  recipeDraftError: string | null;
  isRecipeDraftBusy: boolean;
  recipeImageState: RecipeImageState;
  recipeDraftButtonLabel: string;
  submitDisabled: boolean;
  isCreatingRecipe?: boolean;
  isUpdatingRecipe?: boolean;
  isDeletingRecipe?: boolean;
  showAiDraftAction?: boolean;
  showDeleteAction?: boolean;
  compactHeader?: boolean;
  entityLabel?: string;
  submitLabel?: string;
  previewLabel?: string;
  deleteLabel?: string;
  summaryCreateHint?: string;
  backLabel?: string;
  onBack: () => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onDelete: () => Promise<void> | void;
  onOpenDraftDialog: () => void;
  updateIngredientRow: (id: string, key: 'ingredient_id' | 'quantity' | 'unit' | 'note', value: string) => void;
  selectIngredientRow: (id: string, ingredient: Ingredient | null) => void;
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

type RecipeIngredientPickerProps = {
  row: RecipeDraftIngredient;
  rowIndex: number;
  ingredients: Ingredient[];
  onSelect: (ingredient: Ingredient | null) => void;
};

function RecipeIngredientPicker({ row, rowIndex, ingredients, onSelect }: RecipeIngredientPickerProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const rootRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const selectedIngredient = ingredients.find((ingredient) => ingredient.id === row.ingredient_id) ?? null;
  const selectedLabel = selectedIngredient?.name ?? row.ingredient_name.trim();
  const ingredientSearch = useIngredientResourceSearch(search, {
    enabled: open,
    fallbackIngredients: ingredients,
  });
  const options = useMemo(() => {
    const seen = new Set<string>();
    return [
      selectedIngredient,
      ...ingredientSearch.ingredients,
    ]
      .filter((ingredient): ingredient is Ingredient => Boolean(ingredient))
      .filter((ingredient) => {
        if (seen.has(ingredient.id)) return false;
        seen.add(ingredient.id);
        return true;
      });
  }, [ingredientSearch.ingredients, selectedIngredient]);

  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handlePointerDown);
    return () => document.removeEventListener('mousedown', handlePointerDown);
  }, [open]);

  useEffect(() => {
    if (open) {
      window.setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [open]);

  function openPicker() {
    if (!open) setSearch(selectedLabel || '');
    setOpen(true);
  }

  function selectOption(ingredient: Ingredient | null) {
    onSelect(ingredient);
    setSearch(ingredient?.name ?? '');
    setOpen(false);
  }

  return (
    <div className="recipe-ingredient-picker" ref={rootRef}>
      <SearchableResourceSelect
        className={open ? 'recipe-ingredient-picker-select is-open' : 'recipe-ingredient-picker-select'}
        ariaLabel="选择已有食材"
        placeholder={`选择原料 ${rowIndex + 1}`}
        value={row.ingredient_id ?? ''}
        query={open ? search : selectedLabel}
        presentation="popover"
        listOpen={open}
        loading={ingredientSearch.isSearching}
        loadingMore={ingredientSearch.isFetchingNextPage}
        hasMore={ingredientSearch.hasMore}
        emptyText={ingredientSearch.isSearching ? '正在搜索...' : '没有找到匹配食材'}
        loadMoreText="加载更多食材"
        loadingMoreText="正在加载更多食材..."
        searchInputRef={inputRef}
        options={options.map((ingredient) => ({
          id: ingredient.id,
          label: ingredient.name,
          description: [ingredient.category, `默认 ${ingredient.default_unit}`, ingredient.default_storage].filter(Boolean).join(' · '),
          image: (
            <MediaWithPlaceholder
              src={resolveAssetUrl(ingredient.image?.url)}
              alt={ingredient.name}
              emptyLabel="暂无图"
            />
          ),
        }))}
        onSearchFocus={openPicker}
        onSearchClear={() => selectOption(null)}
        onSearchCompositionStart={ingredientSearch.onCompositionStart}
        onSearchCompositionEnd={ingredientSearch.onCompositionEnd}
        onSearchKeyDown={(event) => {
          if (event.key === 'Escape') {
            setOpen(false);
          }
          if (event.key === 'Enter' && options[0]) {
            event.preventDefault();
            selectOption(options[0]);
          }
        }}
        onQueryChange={(nextSearch) => {
          setSearch(nextSearch);
          setOpen(true);
        }}
        onLoadMore={() => {
          if (ingredientSearch.hasMore && !ingredientSearch.isFetchingNextPage) {
            void ingredientSearch.fetchNextPage();
          }
        }}
        onChange={(ingredientId) => {
          const ingredient = options.find((item) => item.id === ingredientId);
          if (ingredient) selectOption(ingredient);
        }}
      />
    </div>
  );
}

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
  editorCoverUrl,
  editorCoverAsset,
  editorIngredientCount,
  editorStepCount,
  editorCompletionItems,
  editorCompletionPercent,
  recipeDraftError,
  isRecipeDraftBusy,
  recipeImageState,
  recipeDraftButtonLabel,
  submitDisabled,
  isCreatingRecipe,
  isUpdatingRecipe,
  isDeletingRecipe,
  showAiDraftAction = true,
  showDeleteAction = true,
  compactHeader = false,
  entityLabel = '菜谱',
  submitLabel,
  previewLabel,
  deleteLabel,
  summaryCreateHint,
  backLabel,
  onBack,
  onSubmit,
  onDelete,
  onOpenDraftDialog,
  updateIngredientRow,
  selectIngredientRow,
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
          {!compactHeader && (
            <>
              <div className="recipe-editor-topbar">
                <button className="workspace-back-link recipe-detail-back-link" type="button" onClick={() => onBack()}>
                  <RecipeUiIcon name="chevronLeft" />
                  {backLabel ?? (isEditing ? '返回详情' : `返回${entityLabel}`)}
                </button>
              </div>
              <div className="recipe-editor-title-block">
                <p className="eyebrow">{entityLabel}</p>
                <h2>{isEditing ? `编辑${entityLabel}` : `新增${entityLabel}`}</h2>
                <p>把标题、用料、步骤和图片放在同一个录入工作台里。</p>
              </div>
            </>
          )}

          <form className={isRecipeAiApplied ? 'recipe-editor-workbench ai-applied' : 'recipe-editor-workbench'} onSubmit={onSubmit}>
            <main className="recipe-editor-main-column">
              <section className="recipe-editor-card">
                <div className="recipe-editor-card-head">
                  <span className="recipe-editor-section-index">1</span>
                  <h3>基础信息</h3>
                </div>
                <div className="recipe-editor-basic-grid">
                  <label>
                    <span>{entityLabel}名称</span>
                    <input className="text-input" value={form.title} onChange={(event) => setForm({ ...form, title: event.target.value })} />
                  </label>
                  <label>
                    <span>份量</span>
                    <DropdownSelect
                      ariaLabel="选择份量"
                      placeholder="选择份量"
                      value={form.servings}
                      options={SERVING_OPTIONS}
                      onChange={(servings) => setForm({ ...form, servings })}
                    />
                  </label>
                  <label>
                    <span>准备时长（分钟）</span>
                    <input className="text-input" type="number" min="1" value={form.prepMinutes} onChange={(event) => setForm({ ...form, prepMinutes: event.target.value })} />
                  </label>
                  <label>
                    <span>难度</span>
                    <DropdownSelect
                      ariaLabel="选择难度"
                      placeholder="选择难度"
                      value={form.difficulty}
                      options={DIFFICULTY_OPTIONS}
                      onChange={(difficulty) => setForm({ ...form, difficulty: difficulty as Difficulty })}
                    />
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
                  {ingredientRows.map((item, index) => {
                    const selectedIngredient = item.ingredient_id ? ingredients.find((ingredient) => ingredient.id === item.ingredient_id) : null;
                    const usesPresenceOnlyQuantity = isPresenceOnlyRecipeIngredient(item, selectedIngredient ?? undefined);
                    return (
                      <div key={item.id} className="recipe-editor-ingredient-row">
                        <span className="recipe-editor-drag-handle">::</span>

                        <div className="recipe-editor-ingredient-main">
                          <div className="recipe-editor-ingredient-col-left">
                            <RecipeIngredientPicker
                              row={item}
                              rowIndex={index}
                              ingredients={ingredients}
                              onSelect={(ingredient) => selectIngredientRow(item.id, ingredient)}
                            />
                            <input
                              className="text-input recipe-editor-ingredient-note"
                              value={stripRecipeIngredientRequirementNote(item.note)}
                              placeholder="备注 (选填)"
                              onChange={(event) => updateIngredientNote(item.id, event.target.value)}
                            />
                          </div>

                          <div className="recipe-editor-ingredient-col-right">
                            <QuantityUnitField
                              className={usesPresenceOnlyQuantity ? 'recipe-editor-ingredient-presence-field' : 'recipe-editor-ingredient-qty-group'}
                              quantity={item.quantity === undefined || item.quantity === null ? '' : String(item.quantity)}
                              unit={item.unit || '份'}
                              unitOptions={[item.unit || '份', ...SHOPPING_UNIT_OPTIONS]
                                .filter((unit, unitIndex, list) => unit && list.indexOf(unit) === unitIndex)
                                .map((unit) => ({ value: unit, label: unit }))}
                              quantityDisabled={usesPresenceOnlyQuantity}
                              quantityDisabledReason={usesPresenceOnlyQuantity ? '这个食材只记录是否需要，用量写在步骤或备注里。' : undefined}
                              onQuantityChange={(quantity) => updateIngredientRow(item.id, 'quantity', quantity)}
                              onUnitChange={(unit) => updateIngredientRow(item.id, 'unit', unit)}
                            />

                            <label className="recipe-editor-ingredient-must-toggle">
                              <input
                                type="checkbox"
                                checked={getRecipeShoppingRequirement(item) === 'required'}
                                onChange={(event) => updateIngredientRequirement(item.id, event.target.checked ? 'required' : 'optional')}
                              />
                              <span className="toggle-slider" />
                              <span className="toggle-label">必须</span>
                            </label>
                          </div>
                        </div>

                        <button className="recipe-editor-icon-button" type="button" onClick={() => removeIngredientRow(item.id)} aria-label={`删除原料 ${index + 1}`}>
                          <RecipeUiIcon name="minus" />
                        </button>
                      </div>
                    );
                  })}
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
                          <div className="recipe-editor-step-fields-row-1">
                            <label className="recipe-editor-step-field-icon">
                              <span>图标</span>
                              <span className="recipe-editor-icon-select">
                                <DropdownSelect
                                  ariaLabel="选择步骤图标"
                                  placeholder="选择步骤图标"
                                  value={step.icon}
                                  leadingIcon={<RecipeUiIcon name={getRecipeStepIconName(step.icon)} />}
                                  options={RECIPE_STEP_ICON_OPTIONS.map((option) => ({
                                    value: option.value,
                                    label: option.label,
                                    icon: <RecipeUiIcon name={getRecipeStepIconName(option.value)} />
                                  }))}
                                  onChange={(icon) => updateStepDraft(step.id, { icon })}
                                />
                              </span>
                            </label>
                            <label className="recipe-editor-step-field-time">
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
                            <label className="recipe-editor-step-field-title">
                              <span>步骤名称</span>
                              <input
                                className="text-input"
                                value={step.title}
                                placeholder="例如：冷蒸三文鱼"
                                onChange={(event) => updateStepDraft(step.id, { title: event.target.value })}
                              />
                            </label>
                          </div>
                          <div className="recipe-editor-step-fields-row-2">
                            <label className="recipe-editor-step-field-summary">
                              <span>一句话说明</span>
                              <input
                                className="text-input"
                                value={step.summary}
                                placeholder="例如：蒸出嫩滑口感"
                                onChange={(event) => updateStepDraft(step.id, { summary: event.target.value })}
                              />
                            </label>
                          </div>

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
                  <h3>{entityLabel}封面</h3>
                </div>
                <ImageComposer
                  title={`${entityLabel}封面`}
                  value={form.images}
                  previewLabel={form.title || `${entityLabel}封面`}
                  onUpload={(files) => void handleRecipeImageUpload(files)}
                  onGenerate={(mode) => void handleRecipeImageGenerate(mode)}
                  onReset={resetRecipeImageInput}
                  isGenerating={recipeImageState.isGenerating}
                  errorMessage={recipeImageState.errorMessage}
                  variant="workspace-inline"
                  uploadTitle="上传参考图"
                  uploadHint="上传后生成统一风格封面"
                  generatedTitle="封面主图"
                  generateLabel={recipeImageState.isGenerating ? '正在生成...' : undefined}
                  clearLabel="清空图片"
                />
              </section>
            </main>

            <aside className="recipe-editor-side-column">
              {showAiDraftAction && (
                <section className="recipe-editor-side-card recipe-ai-draft-panel">
                  <div className="workspace-action-rail-copy">
                    <p className="eyebrow">AI 生成</p>
                    <h3>自动补全{entityLabel}</h3>
                    <p className="subtle">基于左侧已填写内容生成完整{entityLabel}，保存前仍可继续编辑。</p>
                  </div>
                  {recipeDraftError ? <p className="form-error">{recipeDraftError}</p> : null}
                  <ActionButton
                    tone="secondary"
                    type="button"
                    onClick={() => onOpenDraftDialog()}
                    disabled={isRecipeDraftBusy}
                  >
                    {recipeDraftButtonLabel}
                  </ActionButton>
                </section>
              )}
              <section className="recipe-editor-side-card recipe-editor-summary-card">
                <div className="recipe-editor-summary-head">
                  <div>
                    <h3>实时摘要</h3>
                    <p className="subtle">{isEditing ? '根据当前表单内容预览' : (summaryCreateHint ?? `保存后进入${entityLabel}工作台`)}</p>
                  </div>
                  <span><RecipeUiIcon name="check" /> 表单实时更新</span>
                </div>
                <div className="recipe-editor-live-preview">
                  <MediaWithPlaceholder src={editorCoverUrl} alt={form.title || `${entityLabel}封面`} />
                  <div>
                    <strong>{form.title.trim() || `未命名${entityLabel}`}</strong>
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
                    {isCreatingRecipe || isUpdatingRecipe ? '保存中...' : (submitLabel ?? `保存${entityLabel}`)}
                  </ActionButton>
                  {isEditing && (
                    <ActionButton tone="secondary" type="button" onClick={onBack}>
                      {previewLabel ?? `预览${entityLabel}`}
                    </ActionButton>
                  )}
                  {showDeleteAction && isEditing && selectedRecipeId && (
                    <ActionButton tone="tertiary" type="button" onClick={() => void onDelete()} disabled={isDeletingRecipe}>
                      {isDeletingRecipe ? '删除中...' : (deleteLabel ?? `删除${entityLabel}`)}
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
