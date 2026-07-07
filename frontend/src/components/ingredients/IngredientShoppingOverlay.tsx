import { useMemo, type FormEvent } from 'react';
import type { Ingredient, IngredientUnitConversion } from '../../api/types';
import { MediaWithPlaceholder } from '../MediaPlaceholder';
import { Badge, FormActions, QuantityUnitField, SearchableResourceSelect, WorkspaceModal } from '../ui-kit';
import { resolvePreferredIngredientUnit } from '../../lib/ingredientUnits';
import { tracksIngredientQuantity } from '../../lib/ingredientTracking';
import { resolveMediaUrl } from '../../lib/assets';
import { useIngredientResourceSearch } from '../../hooks/useIngredientResourceSearch';
import { buildUnitPresetOptions, type ShoppingDialogFormState } from './ingredientWorkspaceForms';

type IngredientShoppingOverlayProps = {
  closeOverlay: () => void;
  ingredients: Ingredient[];
  shoppingForm: ShoppingDialogFormState;
  setShoppingForm: (next: ShoppingDialogFormState) => void;
  selectedShoppingIngredient: Ingredient | null;
  selectedShoppingIngredientPreview?: string;
  selectedShoppingIngredientMeta: string[];
  shoppingIngredientUnitOptions: IngredientUnitConversion[];
  shoppingQuantityValue: number;
  shoppingQuantityStep: number;
  shoppingQuantityQuickValues: number[];
  submitShopping: (event: FormEvent<HTMLFormElement>) => Promise<void>;
  isCreatingShopping?: boolean;
};

export function IngredientShoppingOverlay(props: IngredientShoppingOverlayProps) {
  const shoppingFormId = 'ingredient-shopping-overlay-form';
  const shoppingUnitOptions = buildUnitPresetOptions(props.shoppingForm.unit || '个');
  const tracksQuantity = tracksIngredientQuantity(props.selectedShoppingIngredient);
  const ingredientSearch = useIngredientResourceSearch(props.shoppingForm.title, {
    enabled: !props.selectedShoppingIngredient,
    fallbackIngredients: props.ingredients,
  });
  const shoppingQuantityUnitOptions = useMemo(() => {
    const currentUnit = props.shoppingForm.unit || props.selectedShoppingIngredient?.default_unit || '份';
    const units = props.selectedShoppingIngredient
      ? [currentUnit, ...props.shoppingIngredientUnitOptions.map((option) => option.unit)]
      : [currentUnit, ...shoppingUnitOptions];
    return units
      .filter((unit, index, list) => unit && list.indexOf(unit) === index)
      .map((unit) => ({ value: unit, label: unit }));
  }, [props.selectedShoppingIngredient, props.shoppingForm.unit, props.shoppingIngredientUnitOptions, shoppingUnitOptions]);

  return (
    <WorkspaceModal
      title="新增采购项"
      description="从已有食材里选择要买的东西，再记录数量和原因。"
      closeLabel="关闭"
      closeAriaLabel="关闭"
      className="workspace-modal-wide shopping-quick-modal"
      onClose={props.closeOverlay}
      footerActions={
        <FormActions
          className="shopping-quick-actions"
          primaryLabel="加入采购清单"
          primaryType="submit"
          primaryForm={shoppingFormId}
          primaryDisabled={!props.selectedShoppingIngredient}
          isSubmitting={Boolean(props.isCreatingShopping)}
          secondaryLabel="取消"
          onSecondary={props.closeOverlay}
        />
      }
    >
      <form id={shoppingFormId} className="shopping-quick-form" onSubmit={(event) => void props.submitShopping(event)}>
        <div className="shopping-quick-scroll">
          {props.selectedShoppingIngredient ? (
            <section className="ingredients-restock-identity-card">
              <div className="ingredients-restock-identity-media">
                <MediaWithPlaceholder
                  src={props.selectedShoppingIngredientPreview}
                  alt={props.selectedShoppingIngredient.name}
                />
              </div>
              <div className="ingredients-restock-identity-copy">
                <div className="ingredients-restock-identity-head">
                  <div>
                    <h4>{props.selectedShoppingIngredient.name}</h4>
                    <p>{props.selectedShoppingIngredientMeta.join(' · ')}</p>
                  </div>
                  <Badge>档案食材</Badge>
                </div>
              </div>
            </section>
          ) : (
            <div className="shopping-quick-name-field">
              <span>名称</span>
              <SearchableResourceSelect
                ariaLabel="选择采购食材"
                placeholder="输入名称或直接选食材"
                value=""
                query={props.shoppingForm.title}
                presentation="popover"
                loading={ingredientSearch.isSearching}
                loadingMore={ingredientSearch.isFetchingNextPage}
                hasMore={ingredientSearch.hasMore}
                loadMoreText="加载更多食材"
                loadingMoreText="正在加载更多食材..."
                options={ingredientSearch.ingredients.map((ingredient) => ({
                  id: ingredient.id,
                  label: ingredient.name,
                  description: `${ingredient.category || '食材'} · 默认 ${ingredient.default_unit || '个'}`,
                  image: <MediaWithPlaceholder src={resolveMediaUrl(ingredient.image, 'thumb')} alt="" />,
                }))}
                emptyText={ingredientSearch.isSearching ? '正在搜索...' : '没有匹配的食材，请先创建食材档案。'}
                onSearchCompositionStart={ingredientSearch.onCompositionStart}
                onSearchCompositionEnd={ingredientSearch.onCompositionEnd}
                onQueryChange={(nextTitle) => {
                  const matchedIngredient = ingredientSearch.findIngredientByName(nextTitle);
                  props.setShoppingForm({
                    ...props.shoppingForm,
                    title: nextTitle,
                    unit: matchedIngredient
                      ? resolvePreferredIngredientUnit(matchedIngredient, props.shoppingForm.unit) ||
                        matchedIngredient.default_unit
                      : props.shoppingForm.unit,
                  });
                }}
                onLoadMore={() => {
                  if (ingredientSearch.hasMore && !ingredientSearch.isFetchingNextPage) {
                    void ingredientSearch.fetchNextPage();
                  }
                }}
                onChange={(ingredientId) => {
                  const ingredient = ingredientSearch.findIngredientById(ingredientId);
                  if (!ingredient) return;
                  props.setShoppingForm({
                    ...props.shoppingForm,
                    title: ingredient.name,
                    unit: resolvePreferredIngredientUnit(ingredient, props.shoppingForm.unit) || ingredient.default_unit,
                  });
                }}
              />
              {props.shoppingForm.title.trim() && !props.selectedShoppingIngredient && (
                <p className="subtle">采购清单只能选择已有食材。没有这个食材时，请先创建食材档案。</p>
              )}
            </div>
          )}

          <section className="ingredients-restock-field-group ingredients-restock-quantity-section">
            <div className="ingredients-restock-quantity-row">
              <QuantityUnitField
                className="ingredients-shopping-quantity-field"
                quantity={props.shoppingForm.quantity}
                unit={props.shoppingForm.unit || props.selectedShoppingIngredient?.default_unit || '份'}
                unitOptions={shoppingQuantityUnitOptions}
                quantityDisabled={!tracksQuantity}
                quantityDisabledReason={!tracksQuantity ? '只提醒需要补充，不记录具体数量。' : undefined}
                onQuantityChange={(quantity) =>
                  props.setShoppingForm({
                    ...props.shoppingForm,
                    quantity,
                  })
                }
                onUnitChange={(unit) =>
                  props.setShoppingForm({
                    ...props.shoppingForm,
                    unit,
                  })
                }
              />
              <section className="ingredients-restock-unit-card">
                <div className="ingredients-restock-unit-card-head">
                  <span>单位</span>
                  <strong>{props.shoppingForm.unit || props.selectedShoppingIngredient?.default_unit || '个'}</strong>
                </div>
                <p className="subtle">
                  {props.selectedShoppingIngredient ? '默认先用主单位，常用副单位可以在上方切换。' : '默认值不对时再改。'}
                </p>
              </section>
            </div>
          </section>

          <section className="ingredients-restock-field-group">
            <div className="ingredients-restock-field-head">
              <span>原因</span>
              <p className="subtle">留一句自己回头能看懂的备注就行。</p>
            </div>
            <input
              className="text-input"
              placeholder="例如 备一份新的，替换临期库存"
              value={props.shoppingForm.reason}
              onChange={(event) =>
                props.setShoppingForm({ ...props.shoppingForm, reason: event.target.value })
              }
            />
          </section>

        </div>
      </form>
    </WorkspaceModal>
  );
}
