import { useMemo, type FormEvent } from 'react';
import type { Food, Ingredient, IngredientUnitConversion } from '../../api/types';
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
  foods: Food[];
  shoppingForm: ShoppingDialogFormState;
  setShoppingForm: (next: ShoppingDialogFormState) => void;
  selectedShoppingIngredient: Ingredient | null;
  selectedShoppingFood: Food | null;
  selectedShoppingIngredientPreview?: string;
  selectedShoppingFoodPreview?: string;
  selectedShoppingIngredientMeta: string[];
  selectedShoppingFoodMeta: string[];
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
  const selectedTarget = props.selectedShoppingFood ?? props.selectedShoppingIngredient;
  const tracksQuantity = props.selectedShoppingFood ? true : tracksIngredientQuantity(props.selectedShoppingIngredient);
  const ingredientSearch = useIngredientResourceSearch(props.shoppingForm.title, {
    enabled: !props.selectedShoppingIngredient,
    fallbackIngredients: props.ingredients,
  });
  const shoppingQuantityUnitOptions = useMemo(() => {
    const currentUnit = props.shoppingForm.unit || props.selectedShoppingFood?.stock_unit || props.selectedShoppingIngredient?.default_unit || '份';
    const units = props.selectedShoppingFood
      ? [currentUnit, props.selectedShoppingFood.stock_unit || '份', ...shoppingUnitOptions]
      : props.selectedShoppingIngredient
      ? [currentUnit, ...props.shoppingIngredientUnitOptions.map((option) => option.unit)]
      : [currentUnit, ...shoppingUnitOptions];
    return units
      .filter((unit, index, list) => unit && list.indexOf(unit) === index)
      .map((unit) => ({ value: unit, label: unit }));
  }, [props.selectedShoppingFood, props.selectedShoppingIngredient, props.shoppingForm.unit, props.shoppingIngredientUnitOptions, shoppingUnitOptions]);
  const readyFoodOptions = useMemo(() => {
    const query = props.shoppingForm.title.trim();
    return props.foods
      .filter((food) => ['readyMade', 'instant', 'packaged'].includes(food.type))
      .filter((food) => !query || food.name.includes(query) || food.category.includes(query))
      .slice(0, 20);
  }, [props.foods, props.shoppingForm.title]);
  const selectIngredient = (ingredient: Ingredient) => {
    props.setShoppingForm({
      ...props.shoppingForm,
      targetType: 'ingredient',
      ingredientId: ingredient.id,
      foodId: '',
      title: ingredient.name,
      unit: resolvePreferredIngredientUnit(ingredient, props.shoppingForm.unit) || ingredient.default_unit,
      reason: props.shoppingForm.reason,
    });
  };
  const selectFood = (food: Food) => {
    props.setShoppingForm({
      ...props.shoppingForm,
      targetType: 'food',
      ingredientId: '',
      foodId: food.id,
      title: food.name,
      unit: food.stock_unit || '份',
      reason: props.shoppingForm.reason || '补充成品库存',
    });
  };

  return (
    <WorkspaceModal
      title="新增采购项"
      description="从已有食材或成品速食档案里选择采购对象，再记录数量和原因。"
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
          primaryDisabled={!selectedTarget}
          isSubmitting={Boolean(props.isCreatingShopping)}
          secondaryLabel="取消"
          onSecondary={props.closeOverlay}
        />
      }
    >
      <form id={shoppingFormId} className="shopping-quick-form" onSubmit={(event) => void props.submitShopping(event)}>
        <div className="shopping-quick-scroll">
          {selectedTarget ? (
            <section className="ingredients-restock-identity-card">
              <div className="ingredients-restock-identity-media">
                <MediaWithPlaceholder
                  src={props.selectedShoppingFood ? props.selectedShoppingFoodPreview : props.selectedShoppingIngredientPreview}
                  alt={selectedTarget.name}
                />
              </div>
              <div className="ingredients-restock-identity-copy">
                <div className="ingredients-restock-identity-head">
                  <div>
                    <h4>{selectedTarget.name}</h4>
                    <p>{(props.selectedShoppingFood ? props.selectedShoppingFoodMeta : props.selectedShoppingIngredientMeta).join(' · ')}</p>
                  </div>
                  <Badge>{props.selectedShoppingFood ? '成品速食' : '档案食材'}</Badge>
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
                  id: `ingredient:${ingredient.id}`,
                  label: ingredient.name,
                  description: `${ingredient.category || '食材'} · 默认 ${ingredient.default_unit || '个'}`,
                  image: <MediaWithPlaceholder src={resolveMediaUrl(ingredient.image, 'thumb')} alt="" />,
                })).concat(
                  readyFoodOptions.map((food) => ({
                    id: `food:${food.id}`,
                    label: food.name,
                    description: `${food.category || '成品速食'} · ${food.storage_location || '常温'} · 默认 ${food.stock_unit || '份'}`,
                    image: <MediaWithPlaceholder src={resolveMediaUrl(food.images?.[0], 'thumb')} alt="" />,
                  }))
                )}
                emptyText={ingredientSearch.isSearching ? '正在搜索...' : '没有匹配档案，请先创建食材或食物资料。'}
                onSearchCompositionStart={ingredientSearch.onCompositionStart}
                onSearchCompositionEnd={ingredientSearch.onCompositionEnd}
                onQueryChange={(nextTitle) => {
                  const matchedIngredient = ingredientSearch.findIngredientByName(nextTitle);
                  props.setShoppingForm({
                    ...props.shoppingForm,
                    targetType: matchedIngredient ? 'ingredient' : '',
                    ingredientId: matchedIngredient?.id ?? '',
                    foodId: '',
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
                  const [kind, rawId = ''] = ingredientId.split(':');
                  if (kind === 'ingredient') {
                    const ingredient = ingredientSearch.findIngredientById(rawId);
                    if (ingredient) selectIngredient(ingredient);
                    return;
                  }
                  if (kind === 'food') {
                    const food = props.foods.find((item) => item.id === rawId);
                    if (food) selectFood(food);
                  }
                }}
              />
              {props.shoppingForm.title.trim() && !selectedTarget && (
                <p className="subtle">采购清单只能选择已有档案。成品和速食请先在食物里建好资料。</p>
              )}
            </div>
          )}

          <section className="ingredients-restock-field-group ingredients-restock-quantity-section">
            <div className="ingredients-restock-quantity-row">
              <QuantityUnitField
                className="ingredients-shopping-quantity-field"
                quantity={props.shoppingForm.quantity}
                unit={props.shoppingForm.unit || props.selectedShoppingFood?.stock_unit || props.selectedShoppingIngredient?.default_unit || '份'}
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
                  <strong>{props.shoppingForm.unit || props.selectedShoppingFood?.stock_unit || props.selectedShoppingIngredient?.default_unit || '个'}</strong>
                </div>
                <p className="subtle">
                  {props.selectedShoppingFood ? '成品买回后会进入补库存流程。' : props.selectedShoppingIngredient ? '默认先用主单位，常用副单位可以在上方切换。' : '默认值不对时再改。'}
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
