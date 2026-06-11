import type { Dispatch, FormEventHandler, SetStateAction } from 'react';
import type { Food, FoodType, MealType, Recipe } from '../../api/types';
import { FOOD_TYPE_LABELS } from '../../lib/ui';
import { ActionButton, Badge, ImageComposer, WorkspaceSubpageHeader, WorkspaceSubpageShell } from '../ui-kit';
import {
  FOOD_CREATE_TYPE_DETAILS,
  FOOD_CREATE_TYPE_OPTIONS,
  MEAL_OPTIONS,
} from './FoodWorkspaceOptions';
import type { FoodFormState } from './FoodWorkspaceModel';
import { FoodRatingInput, FoodUiIcon } from './FoodWorkspacePrimitives';
import type { ImageGenerationUiState } from '../../hooks/useImageComposer';

type CompletionItem = {
  label: string;
  done: boolean;
};

type EditorProfile = {
  title: string;
  description: string;
};

type Props = {
  availableSceneTagOptions: string[];
  canSubmit: boolean;
  completionItems: CompletionItem[];
  completionPercent: number;
  currentRecipe?: Recipe | null;
  editorFoodTitle: string;
  editorProfile: EditorProfile;
  editorRecipeCover?: string;
  editorRecipeMeta: string;
  form: FoodFormState;
  isSavingFood?: boolean;
  isSceneTagPickerOpen: boolean;
  isSelfMade: boolean;
  isUpdatingScene?: boolean;
  newSceneTagName: string;
  sceneTags: string[];
  view: 'create' | 'edit';
  imageState: ImageGenerationUiState;
  embedded?: boolean;
  onAddSceneTag: (tag: string) => void;
  onBack: () => void;
  onCreateAndAddSceneTag: () => void;
  onFormChange: Dispatch<SetStateAction<FoodFormState>>;
  onGenerateImage: (mode: 'reference' | 'text') => void;
  onEditRecipe: () => void;
  onRemoveSceneTag: (tag: string) => void;
  onResetImage: () => void;
  onSceneTagPickerToggle: () => void;
  onSubmit: FormEventHandler<HTMLFormElement>;
  onToggleMealType: (mealType: MealType, checked: boolean) => void;
  onUploadImage: (files: FileList | null) => void;
  resolveAssetUrl: (url: string) => string;
  setNewSceneTagName: (value: string) => void;
};

function normalizeFormFoodType(foodType: FoodType): Exclude<FoodType, 'packaged'> {
  return foodType === 'packaged' ? 'readyMade' : foodType;
}

function isOutsideType(foodType: FoodType) {
  const normalizedType = normalizeFormFoodType(foodType);
  return normalizedType === 'takeout' || normalizedType === 'diningOut';
}

function isReadyLikeType(foodType: FoodType) {
  const normalizedType = normalizeFormFoodType(foodType);
  return normalizedType === 'readyMade' || normalizedType === 'instant';
}

export function FoodEditorForm(props: Props) {
  const editorContent = (
    <WorkspaceSubpageShell className="food-editor-shell">
      {!props.embedded && (
        <WorkspaceSubpageHeader
          eyebrow="食物"
          title={props.view === 'create' ? '新增食物' : '编辑食物'}
          description={props.isSelfMade ? '家常菜由菜谱提供核心信息，这里只做映射和常用记录。' : '补充来源、价格、复购和保质信息，让常吃食物更容易再次安排。'}
          backLabel="返回食物库"
          onBack={props.onBack}
          meta={<Badge>{FOOD_TYPE_LABELS[props.form.type]}</Badge>}
          variant="compact"
        />
      )}
        <form className="food-editor-layout" onSubmit={props.onSubmit}>
          <section className="food-editor-main">
            <div className="food-form-panel food-editor-identity-panel">
              <div className="section-mini-title">{props.isSelfMade ? '关联菜谱' : '先选类型，再填名称'}</div>
              {!props.isSelfMade && (
                <div className="food-type-grid">
                  {FOOD_CREATE_TYPE_OPTIONS.map((item) => {
                    const detail = FOOD_CREATE_TYPE_DETAILS[item.value];
                    return (
                      <button
                        key={item.value}
                        className={props.form.type === item.value ? 'food-type-card active' : 'food-type-card'}
                        type="button"
                        onClick={() => props.onFormChange({ ...props.form, type: item.value, category: '' })}
                      >
                        <span className="food-type-card-icon">{detail && <FoodUiIcon name={detail.icon} />}</span>
                        <span className="food-type-card-copy">
                          <strong>{item.label}</strong>
                          <small>{detail?.description}</small>
                        </span>
                      </button>
                    );
                  })}
                </div>
              )}
              {props.isSelfMade ? (
                <div className="food-editor-recipe-card">
                  <div className="food-editor-recipe-cover">
                    {props.editorRecipeCover ? <img src={props.resolveAssetUrl(props.editorRecipeCover)} alt="" /> : <FoodUiIcon name="bowl" />}
                  </div>
                  <div className="food-editor-recipe-copy">
                    <strong>{props.currentRecipe?.title || props.form.name || '还没有关联菜谱'}</strong>
                    <span>名称、主图、食材和做法来自菜谱；这里维护餐别、场景和备注。</span>
                  </div>
                  <ActionButton tone="secondary" size="compact" type="button" onClick={props.onEditRecipe}>
                    <span>编辑菜谱</span>
                    <FoodUiIcon name="arrowRight" />
                  </ActionButton>
                </div>
              ) : (
                <div className="form-grid nested-grid food-name-grid">
                  <label>
                    <span>食物名称</span>
                    <input className="text-input" placeholder="例如：公司楼下牛肉饭、全家饭团" value={props.form.name} onChange={(event) => props.onFormChange({ ...props.form, name: event.target.value })} />
                  </label>
                </div>
              )}
            </div>

            {!props.isSelfMade && (
              <ImageComposer
                title="食物图片"
                value={props.form.images}
                previewLabel={props.form.name || props.currentRecipe?.title || '食物'}
                onUpload={props.onUploadImage}
                onGenerate={props.onGenerateImage}
                onReset={props.onResetImage}
                isGenerating={props.imageState.isGenerating}
                errorMessage={props.imageState.errorMessage}
                variant="workspace-inline"
              />
            )}

            <div className={isOutsideType(props.form.type) ? 'food-form-panel food-editor-focus-panel food-editor-repurchase-panel' : 'food-form-panel food-editor-focus-panel'}>
              {props.isSelfMade ? (
                <div className="food-editor-map-summary">
                  <div className="food-editor-map-icon">
                    <FoodUiIcon name="clipboard" />
                  </div>
                  <div>
                    <div className="section-mini-title">食物映射摘要</div>
                    <strong>{props.editorFoodTitle} · {props.editorRecipeMeta}</strong>
                    <p className="subtle">做法与步骤以菜谱页为准，这里仅维护映射信息与常用记录。</p>
                  </div>
                </div>
              ) : (
                <>
                  <div className="food-editor-focus-head">
                    <div>
                      <div className="section-mini-title">{props.editorProfile.title}</div>
                      <p className="subtle">{props.editorProfile.description}</p>
                    </div>
                    <Badge>{FOOD_TYPE_LABELS[normalizeFormFoodType(props.form.type)]}</Badge>
                  </div>
                  <div className={isOutsideType(props.form.type) ? 'food-repurchase-panel-grid' : 'form-grid nested-grid'}>
                    <label>
                      <span>{isOutsideType(props.form.type) ? (props.form.type === 'takeout' ? '店铺' : '餐厅') : '品牌 / 来源'}</span>
                      <input className="text-input" placeholder={isOutsideType(props.form.type) ? (props.form.type === 'takeout' ? '例如：麦当劳、常点轻食店' : '例如：楼下日料店') : '例如：品牌或来源'} value={props.form.sourceName} onChange={(event) => props.onFormChange({ ...props.form, sourceName: event.target.value })} />
                    </label>
                    <label>
                      <span>{isOutsideType(props.form.type) ? '平台 / 位置' : '购买渠道'}</span>
                      <input className="text-input" placeholder={isOutsideType(props.form.type) ? (props.form.type === 'takeout' ? '例如：美团、饿了么' : '例如：商场、街区') : '例如：超市、便利店'} value={props.form.purchaseSource} onChange={(event) => props.onFormChange({ ...props.form, purchaseSource: event.target.value })} />
                    </label>
                    {isOutsideType(props.form.type) && (
                      <>
                        <label>
                          <span>价格 / 人均</span>
                          <input className="text-input" type="number" min="0" step="0.01" placeholder="例如：38" value={props.form.price} onChange={(event) => props.onFormChange({ ...props.form, price: event.target.value })} />
                        </label>
                        <label>
                          <span>评分</span>
                          <FoodRatingInput value={props.form.rating} onChange={(rating) => props.onFormChange((current) => ({ ...current, rating }))} />
                        </label>
                        <div className="food-repurchase-choice-field">
                          <span>复购意愿</span>
                          <div className="food-repurchase-choice-group" role="radiogroup" aria-label="复购意愿">
                            {[
                              { value: 'unknown', label: '未记录' },
                              { value: 'yes', label: '愿意复购' },
                              { value: 'no', label: '暂不复购' },
                            ].map((item) => (
                              <button
                                key={item.value}
                                className={props.form.repurchase === item.value ? 'active' : ''}
                                type="button"
                                role="radio"
                                aria-checked={props.form.repurchase === item.value}
                                onClick={() => props.onFormChange((current) => ({ ...current, repurchase: item.value as FoodFormState['repurchase'] }))}
                              >
                                {item.label}
                              </button>
                            ))}
                          </div>
                        </div>
                      </>
                    )}
                    {isReadyLikeType(props.form.type) && (
                      <>
                        <label>
                          <span>保质日期</span>
                          <input className="text-input" type="date" value={props.form.expiryDate} onChange={(event) => props.onFormChange({ ...props.form, expiryDate: event.target.value })} />
                        </label>
                        <label>
                          <span>剩余数量</span>
                          <input className="text-input" type="number" min="0" step="0.5" value={props.form.stockQuantity} onChange={(event) => props.onFormChange({ ...props.form, stockQuantity: event.target.value })} />
                        </label>
                        <label>
                          <span>数量单位</span>
                          <input className="text-input" value={props.form.stockUnit} onChange={(event) => props.onFormChange({ ...props.form, stockUnit: event.target.value })} />
                        </label>
                      </>
                    )}
                  </div>
                </>
              )}
            </div>

            <div className={props.isSelfMade ? 'food-form-panel food-editor-notes-panel' : 'food-form-panel'}>
              <div className="section-mini-title">餐别、场景标签和备注</div>
              <div className="food-editor-meta-grid">
                <section className="food-editor-meta-card food-editor-meal-card">
                  <div className="food-editor-field-head">
                    <span>适合餐别</span>
                    <small>最多可选多个，用于推荐和筛选</small>
                  </div>
                  <div className="food-meal-checks">
                    {MEAL_OPTIONS.map((item) => (
                      <label key={item.value} className="food-check-pill">
                        <input
                          type="checkbox"
                          checked={props.form.suitableMealTypes.includes(item.value)}
                          onChange={(event) => props.onToggleMealType(item.value, event.target.checked)}
                        />
                        <FoodUiIcon name={item.value === 'dinner' ? 'moon' : item.value === 'snack' ? 'bowl' : 'sun'} />
                        <span>{item.label}</span>
                      </label>
                    ))}
                  </div>
                </section>

                <label className="food-editor-meta-card food-editor-favorite-row">
                  <div className="food-editor-field-head">
                    <span>加入收藏</span>
                    <small>收藏后可在食物库快速找到</small>
                  </div>
                  <input type="checkbox" checked={props.form.favorite} onChange={(event) => props.onFormChange({ ...props.form, favorite: event.target.checked })} />
                  <i aria-hidden="true" />
                </label>

                <section className="food-editor-meta-card food-editor-tag-card">
                  <div className="food-editor-field-head">
                    <span>场景标签</span>
                    <small>比如家常菜、快手菜、工作日午餐</small>
                  </div>
                  <div className="food-editor-tag-stack">
                    <div className="food-editor-scene-tags">
                      {props.sceneTags.map((tag) => (
                        <button key={tag} type="button" onClick={() => props.onRemoveSceneTag(tag)}>
                          {tag}
                          <span>×</span>
                        </button>
                      ))}
                      <button className="food-editor-add-tag" type="button" onClick={props.onSceneTagPickerToggle}>
                        <FoodUiIcon name="plus" />
                        添加标签
                      </button>
                    </div>
                    {props.isSceneTagPickerOpen && (
                      <div className="food-scene-tag-picker">
                        <div className="food-scene-tag-picker-head">
                          <strong>选择已有标签</strong>
                          <span>{props.availableSceneTagOptions.length > 0 ? '点击后加入当前食物' : '已有标签都已选中'}</span>
                        </div>
                        {props.availableSceneTagOptions.length > 0 ? (
                          <div className="food-scene-tag-options">
                            {props.availableSceneTagOptions.map((tag) => (
                              <button key={tag} type="button" onClick={() => props.onAddSceneTag(tag)}>
                                {tag}
                              </button>
                            ))}
                          </div>
                        ) : (
                          <p className="food-scene-tag-empty">暂无可选标签，可以创建一个新标签。</p>
                        )}
                        <div className="food-scene-tag-create">
                          <input className="text-input" value={props.newSceneTagName} placeholder="创建新标签，例如：周末轻食" onChange={(event) => props.setNewSceneTagName(event.target.value)} />
                          <ActionButton tone="secondary" size="compact" type="button" disabled={props.isUpdatingScene || !props.newSceneTagName.trim()} onClick={props.onCreateAndAddSceneTag}>
                            创建并添加
                          </ActionButton>
                        </div>
                      </div>
                    )}
                  </div>
                </section>

                <section className="food-editor-meta-card">
                  <div className="food-editor-field-head">
                    <span>常用备注</span>
                    <small>一句话提示家庭成员或复吃场景</small>
                  </div>
                  <div className="food-editor-note-input">
                    <input className="text-input" maxLength={50} value={props.form.routineNote} placeholder="例如：孩子也能吃、适合减脂、少油少盐" onChange={(event) => props.onFormChange({ ...props.form, routineNote: event.target.value })} />
                    <small>{props.form.routineNote.length}/50</small>
                  </div>
                </section>

                <section className="food-editor-meta-card food-editor-detail-card">
                  <div className="food-editor-field-head">
                    <span>详细备注</span>
                    <small>补充口味、保存方式、复热提醒等</small>
                  </div>
                  <div className="food-editor-note-input">
                    <textarea className="text-input" maxLength={200} rows={3} value={props.form.notes} onChange={(event) => props.onFormChange({ ...props.form, notes: event.target.value })} />
                    <small>{props.form.notes.length}/200</small>
                  </div>
                </section>
              </div>
            </div>
          </section>

          <aside className="food-editor-side">
            <div className="food-editor-summary sticky-panel">
              <p className="eyebrow">即将保存</p>
              <h3>{props.editorFoodTitle}</h3>
              <p className="subtle">{props.isSelfMade ? '家常菜的名称、主图和做法以菜谱为准。' : '保存后可从卡片直接加入今天餐食。'}</p>
              {props.isSelfMade && !props.form.recipeId && <div className="workspace-inline-note">家常菜需要先关联一个菜谱。</div>}
              <div className="food-editor-completion">
                <div className="food-editor-completion-head">
                  <span>资料完整度</span>
                  <strong>{props.completionPercent}%</strong>
                </div>
                <div className="food-editor-completion-bar">
                  <span style={{ width: `${props.completionPercent}%` }} />
                </div>
                <div className="food-editor-completion-list">
                  {props.completionItems.map((item) => (
                    <span key={item.label} className={item.done ? 'done' : ''}>
                      {item.label}
                    </span>
                  ))}
                </div>
              </div>
              <div className="workspace-rail-actions">
                <ActionButton tone="primary" type="submit" disabled={!props.canSubmit}>
                  <FoodUiIcon name="save" />
                  <span>{props.isSavingFood ? '保存中...' : props.imageState.isGenerating ? '生成主图中...' : props.view === 'create' ? '保存食物' : '保存修改'}</span>
                </ActionButton>
                <ActionButton tone="secondary" type="button" onClick={props.onBack}>
                  <FoodUiIcon name="arrowLeft" />
                  <span>返回食物库</span>
                </ActionButton>
              </div>
            </div>
          </aside>
      </form>
    </WorkspaceSubpageShell>
  );

  return props.embedded
    ? <div className="food-editor-embedded">{editorContent}</div>
    : <main className="food-workspace">{editorContent}</main>;
}
