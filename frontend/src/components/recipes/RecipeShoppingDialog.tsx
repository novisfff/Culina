import type { Ingredient, RecipeIngredient } from '../../api/types';
import { MediaWithPlaceholder } from '../MediaPlaceholder';
import { ActionButton, Badge, EmptyState, WorkspaceModal } from '../ui-kit';
import {
  buildRecipeIngredientAvailabilityMap,
  buildShoppingDraftSourceLabel,
  buildShoppingPayloadsFromDrafts,
  buildShoppingRequirementLabel,
  formatShoppingQuantity,
  getRecipeShoppingRequirement,
  type RecipeShoppingCustomForm,
  type RecipeShoppingDraftItem,
  type RecipeShoppingIngredientOption,
} from './RecipeWorkspaceModel';
import { RecipeUiIcon } from './RecipeWorkspaceCards';
import type { RecipeCardViewModel } from './workspaceModel';

type RecipeShoppingDialogProps = {
  card: RecipeCardViewModel;
  ingredients: Ingredient[];
  drafts: RecipeShoppingDraftItem[];
  customForm: RecipeShoppingCustomForm;
  ingredientOptions: RecipeShoppingIngredientOption[];
  visibleIngredientOptions: RecipeShoppingIngredientOption[];
  isIngredientPickerOpen: boolean;
  isCreatingShopping?: boolean;
  unitOptions: string[];
  resolveIngredientImageUrl: (ingredient: Ingredient | null | undefined, fallbackName: string) => string;
  onClose: () => void;
  onUpdateDraft: (
    itemId: string,
    patch: Partial<Pick<RecipeShoppingDraftItem, 'title' | 'quantity' | 'unit' | 'reason' | 'quantityMode' | 'displayLabel' | 'ingredientId'>>
  ) => void;
  onAdjustDraftQuantity: (itemId: string, delta: number) => void;
  onRemoveDraft: (itemId: string) => void;
  onAddRecipeIngredient: (item: RecipeIngredient) => void;
  onChangeCustomForm: (form: RecipeShoppingCustomForm) => void;
  onSetIngredientPickerOpen: (open: boolean) => void;
  onSelectIngredientOption: (option: RecipeShoppingIngredientOption) => void;
  onAdjustCustomQuantity: (delta: number) => void;
  onAddCustomDraft: () => void;
  onSubmit: () => void;
};

export function RecipeShoppingDialog(props: RecipeShoppingDialogProps) {
  return (
    <div className="workspace-overlay-root">
      <div className="workspace-overlay-backdrop" onClick={props.onClose} />
      <WorkspaceModal
        title="加入采购清单"
        description={props.card.recipe.title}
        eyebrow="采购确认"
        closeLabel="×"
        closeAriaLabel="关闭采购确认"
        onClose={props.onClose}
        className="recipe-shopping-modal"
      >
        <div className="recipe-shopping-dialog">
          <section className="recipe-shopping-draft-section">
            <div className="recipe-shopping-section-head">
              <div>
                <h3>待加入采购清单</h3>
                <p>确认数量和单位后加入清单。</p>
              </div>
              <Badge>{props.drafts.length} 项</Badge>
            </div>
            {props.drafts.length > 0 ? (
              <div className="recipe-shopping-draft-list">
                {props.drafts.map((item) => {
                  const linkedIngredient =
                    (item.ingredientId ? props.ingredients.find((ingredient) => ingredient.id === item.ingredientId) ?? null : null) ??
                    props.ingredients.find((ingredient) => ingredient.name === item.title) ??
                    null;
                  const usesPresenceQuantity = item.quantityMode === 'not_track_quantity';
                  return (
                    <article key={item.id} className="recipe-shopping-draft-row">
                      <div className="recipe-shopping-media">
                        <MediaWithPlaceholder
                          src={props.resolveIngredientImageUrl(linkedIngredient, item.title)}
                          alt={item.title || '采购项'}
                        />
                      </div>
                      <div className="recipe-shopping-draft-main">
                        <div className="recipe-shopping-draft-title">
                          <strong>{item.title || '未命名食材'}</strong>
                          <span className={`recipe-shopping-pill tone-${item.requirement}`}>{buildShoppingRequirementLabel(item.requirement)}</span>
                          <span className="recipe-shopping-pill">{buildShoppingDraftSourceLabel(item.source)}</span>
                          {usesPresenceQuantity && <span className="recipe-shopping-pill tone-presence">只记录有无</span>}
                        </div>
                        <input
                          className="text-input"
                          value={item.title}
                          placeholder="采购项名称"
                          onChange={(event) => props.onUpdateDraft(item.id, { title: event.target.value })}
                        />
                      </div>
                      <div className="recipe-shopping-draft-controls">
                        {usesPresenceQuantity ? (
                          <label className="recipe-shopping-presence-control">
                            <span>采购表达</span>
                            <input
                              value={item.displayLabel ?? '需要补充'}
                              placeholder="需要补充"
                              onChange={(event) => props.onUpdateDraft(item.id, { displayLabel: event.target.value })}
                            />
                          </label>
                        ) : (
                          <>
                            <div className="recipe-shopping-stepper" aria-label={`${item.title} 数量`}>
                              <button type="button" onClick={() => props.onAdjustDraftQuantity(item.id, -1)} aria-label={`${item.title} 数量减一`}>
                                <RecipeUiIcon name="minus" />
                              </button>
                              <input
                                value={item.quantity}
                                inputMode="decimal"
                                onChange={(event) => props.onUpdateDraft(item.id, { quantity: event.target.value })}
                              />
                              <button type="button" onClick={() => props.onAdjustDraftQuantity(item.id, 1)} aria-label={`${item.title} 数量加一`}>
                                <RecipeUiIcon name="plus" />
                              </button>
                            </div>
                            <div className="recipe-shopping-select-shell">
                              <select
                                value={item.unit}
                                onChange={(event) => props.onUpdateDraft(item.id, { unit: event.target.value })}
                                aria-label={`${item.title} 单位`}
                              >
                                {[item.unit, ...props.unitOptions].filter((unit, index, list) => unit && list.indexOf(unit) === index).map((unit) => (
                                  <option key={unit} value={unit}>{unit}</option>
                                ))}
                              </select>
                              <RecipeUiIcon name="chevronDown" />
                            </div>
                          </>
                        )}
                        <button className="recipe-shopping-delete-button" type="button" onClick={() => props.onRemoveDraft(item.id)}>删除</button>
                      </div>
                    </article>
                  );
                })}
              </div>
            ) : (
              <EmptyState title="还没有待加入项" description="可以从下方已有食材点加号，或添加任意食材。" />
            )}
          </section>

          <section className="recipe-shopping-candidate-section">
            <div className="recipe-shopping-section-head compact">
              <div>
                <h3>菜谱已有食材</h3>
                <p>点加号补进待买项。</p>
              </div>
            </div>
            <div className="recipe-shopping-candidate-list">
              {props.card.recipe.ingredient_items.map((item) => {
                const availability = buildRecipeIngredientAvailabilityMap(props.card).get(item.id);
                const alreadyAdded = props.drafts.some((draft) => draft.recipeIngredientId === item.id);
                const requirement = getRecipeShoppingRequirement(item);
                const linkedIngredient = item.ingredient_id ? props.ingredients.find((ingredient) => ingredient.id === item.ingredient_id) ?? null : null;
                return (
                  <article key={item.id} className="recipe-shopping-candidate-row">
                    <div className="recipe-shopping-candidate-media">
                      <MediaWithPlaceholder
                        src={props.resolveIngredientImageUrl(linkedIngredient, item.ingredient_name)}
                        alt={item.ingredient_name}
                      />
                    </div>
                    <div>
                      <strong>{item.ingredient_name}</strong>
                      <span>
                        {formatShoppingQuantity(item.quantity)}{item.unit} · {buildShoppingRequirementLabel(requirement)} ·{' '}
                        {availability?.ready
                          ? '已有'
                          : availability?.shortageType === 'presence'
                            ? '需补充'
                            : availability
                              ? `缺 ${formatShoppingQuantity(availability.missingQuantity)}${availability.unit}`
                              : '未匹配库存'}
                      </span>
                    </div>
                    <button type="button" disabled={alreadyAdded} onClick={() => props.onAddRecipeIngredient(item)}>
                      {alreadyAdded ? '已加入' : <RecipeUiIcon name="plus" />}
                    </button>
                  </article>
                );
              })}
            </div>
          </section>

          <section className="recipe-shopping-custom-section">
            <div className="recipe-shopping-section-head compact">
              <div>
                <h3>添加任意食材</h3>
                <p>顺手补其他要买的东西。</p>
              </div>
            </div>
            <div className="recipe-shopping-custom-row">
              <div className="recipe-shopping-combobox">
                <div className="recipe-shopping-combobox-field">
                  <RecipeUiIcon name="search" />
                  <input
                    value={props.customForm.title}
                    placeholder="搜索或输入食材名称"
                    onFocus={() => props.onSetIngredientPickerOpen(true)}
                    onChange={(event) => {
                      const nextTitle = event.target.value;
                      const matched = props.ingredientOptions.find((item) => item.name === nextTitle);
                      props.onChangeCustomForm({
                        ...props.customForm,
                        title: nextTitle,
                        unit: matched?.unit ?? props.customForm.unit,
                      });
                      props.onSetIngredientPickerOpen(true);
                    }}
                  />
                </div>
                {props.isIngredientPickerOpen && props.visibleIngredientOptions.length > 0 && (
                  <div className="recipe-shopping-combobox-menu">
                    {props.visibleIngredientOptions.map((option) => (
                      <button key={option.id} type="button" onClick={() => props.onSelectIngredientOption(option)}>
                        <MediaWithPlaceholder src={option.imageUrl} alt="" />
                        <span>
                          <strong>{option.name}</strong>
                          <small>{option.category || '食材'} · 默认 {option.unit}</small>
                        </span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
              <div className="recipe-shopping-custom-quantity">
                <button type="button" onClick={() => props.onAdjustCustomQuantity(-1)} aria-label="自定义食材数量减一">
                  <RecipeUiIcon name="minus" />
                </button>
                <input
                  value={props.customForm.quantity}
                  inputMode="decimal"
                  placeholder="数量"
                  onChange={(event) => props.onChangeCustomForm({ ...props.customForm, quantity: event.target.value })}
                />
                <button type="button" onClick={() => props.onAdjustCustomQuantity(1)} aria-label="自定义食材数量加一">
                  <RecipeUiIcon name="plus" />
                </button>
              </div>
              <div className="recipe-shopping-select-shell">
                <select
                  value={props.customForm.unit}
                  onChange={(event) => props.onChangeCustomForm({ ...props.customForm, unit: event.target.value })}
                  aria-label="自定义食材单位"
                >
                  {[props.customForm.unit, ...props.unitOptions].filter((unit, index, list) => unit && list.indexOf(unit) === index).map((unit) => (
                    <option key={unit} value={unit}>{unit}</option>
                  ))}
                </select>
                <RecipeUiIcon name="chevronDown" />
              </div>
              <button className="recipe-shopping-add-button" type="button" onClick={props.onAddCustomDraft}>加入</button>
            </div>
          </section>

          <div className="recipe-shopping-footer-bar">
            <div className="recipe-shopping-footer-summary">
              <span><RecipeUiIcon name="clipboard" /></span>
              <p>已选择 <strong>{buildShoppingPayloadsFromDrafts(props.drafts).length} 项</strong>，将加入采购清单</p>
            </div>
            <div className="workspace-overlay-actions">
              <ActionButton tone="secondary" type="button" onClick={props.onClose}>
                取消
              </ActionButton>
              <ActionButton tone="primary" type="button" onClick={props.onSubmit} disabled={props.isCreatingShopping || props.drafts.length === 0}>
                {props.isCreatingShopping ? '加入中...' : '确认加入清单'}
              </ActionButton>
            </div>
          </div>
        </div>
      </WorkspaceModal>
    </div>
  );
}
