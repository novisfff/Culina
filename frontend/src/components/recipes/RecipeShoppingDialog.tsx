import type { Ingredient, RecipeIngredient } from '../../api/types';
import { MediaWithPlaceholder } from '../MediaPlaceholder';
import { Badge, EmptyState, FormActions, QuantityUnitField, ResourcePickerField, WorkspaceModal } from '../ui-kit';
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
        closeLabel="关闭"
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
                          <QuantityUnitField
                            quantity={item.quantity === '' || item.quantity === null || item.quantity === undefined ? '' : String(item.quantity)}
                            unit={item.unit || '份'}
                            unitOptions={[item.unit || '份', ...props.unitOptions]
                              .filter((unit, index, list) => unit && list.indexOf(unit) === index)
                              .map((unit) => ({ value: unit, label: unit }))}
                            onQuantityChange={(value) => props.onUpdateDraft(item.id, { quantity: value })}
                            onUnitChange={(unit) => props.onUpdateDraft(item.id, { unit })}
                          />
                        )}
                        <button className="recipe-shopping-delete-button" type="button" onClick={() => props.onRemoveDraft(item.id)}>删除</button>
                      </div>
                    </article>
                  );
                })}
              </div>
            ) : (
              <EmptyState title="还没有待加入项" description="可以从下方已有食材点加号，或从食材库选择要补买的食材。" />
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
                const canAddIngredient = Boolean(item.ingredient_id);
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
                    <button type="button" disabled={alreadyAdded || !canAddIngredient} onClick={() => props.onAddRecipeIngredient(item)}>
                      {alreadyAdded ? '已加入' : canAddIngredient ? <RecipeUiIcon name="plus" /> : '先建档'}
                    </button>
                  </article>
                );
              })}
            </div>
          </section>

          <section className="recipe-shopping-custom-section">
            <div className="recipe-shopping-section-head compact">
              <div>
                <h3>从食材库添加</h3>
                <p>先选择已有食材，再补数量和单位。</p>
              </div>
            </div>
            <div className="recipe-shopping-custom-row">
              <ResourcePickerField
                className="recipe-shopping-combobox"
                searchClassName="recipe-shopping-combobox-field"
                listClassName="recipe-shopping-combobox-menu"
                ariaLabel="从食材库添加"
                placeholder="搜索食材库"
                value={props.customForm.ingredientId ?? ''}
                query={props.customForm.title}
                options={props.visibleIngredientOptions.map((option) => ({
                  id: option.id,
                  label: option.name,
                  description: `${option.category || '食材'} · 默认 ${option.unit}`,
                  image: <MediaWithPlaceholder src={option.imageUrl} alt="" />,
                }))}
                emptyText="没有匹配的食材，请先去食材库建档。"
                onQueryChange={(nextTitle) => {
                  const matched = props.ingredientOptions.find((item) => item.name === nextTitle);
                  props.onChangeCustomForm({
                    ...props.customForm,
                    ingredientId: matched?.id ?? null,
                    title: nextTitle,
                    unit: matched?.unit ?? props.customForm.unit,
                  });
                  props.onSetIngredientPickerOpen(true);
                }}
                onChange={(ingredientId) => {
                  const option = props.ingredientOptions.find((item) => item.id === ingredientId);
                  if (option) props.onSelectIngredientOption(option);
                }}
              />
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
              <button className="recipe-shopping-add-button" type="button" onClick={props.onAddCustomDraft} disabled={!props.customForm.ingredientId}>加入</button>
            </div>
          </section>

          <div className="recipe-shopping-footer-bar">
            <div className="recipe-shopping-footer-summary">
              <span><RecipeUiIcon name="clipboard" /></span>
              <p>已选择 <strong>{buildShoppingPayloadsFromDrafts(props.drafts).length} 项</strong>，将加入采购清单</p>
            </div>
            <FormActions
              className="recipe-shopping-actions"
              primaryLabel="确认加入清单"
              primaryDisabled={props.drafts.length === 0}
              isSubmitting={Boolean(props.isCreatingShopping)}
              secondaryLabel="取消"
              onPrimary={props.onSubmit}
              onSecondary={props.onClose}
            />
          </div>
        </div>
      </WorkspaceModal>
    </div>
  );
}
