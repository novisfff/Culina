import { useMemo, type FormEvent } from 'react';
import type { Ingredient, IngredientUnitConversion } from '../../api/types';
import { resolveMediaUrl } from '../../lib/assets';
import { tracksIngredientQuantity } from '../../lib/ingredientTracking';
import { useIngredientResourceSearch } from '../../hooks/useIngredientResourceSearch';
import { MediaWithPlaceholder } from '../MediaPlaceholder';
import {
  Badge,
  FormActions,
  SearchableResourceSelect,
  WorkspaceModal,
} from '../ui-kit';
import {
  IngredientRestockAdvancedSection,
  IngredientRestockExpirySection,
  IngredientRestockIdentitySection,
  IngredientRestockPurchaseSection,
  IngredientRestockQuantitySection,
  IngredientRestockStorageSection,
  resolvePurchaseDatePatch,
} from './IngredientRestockSections';
import {
  resolveExpiryDateFromDays,
  type InventoryDrawerFormState,
} from './ingredientWorkspaceForms';

type IngredientInventoryOverlayProps = {
  closeOverlay: () => void;
  inventoryForm: InventoryDrawerFormState;
  setInventoryForm: (next: InventoryDrawerFormState) => void;
  inventoryAdvancedOpen: boolean;
  setInventoryAdvancedOpen: (next: boolean) => void;
  quickRestockIngredients: Ingredient[];
  ingredients: Ingredient[];
  selectedInventoryIngredient: Ingredient | null;
  selectedIngredientPreview?: string;
  selectedIngredientMeta: string[];
  inventoryUnitOptions: IngredientUnitConversion[];
  selectedInventoryUnit: IngredientUnitConversion | null;
  inventoryNormalizedQuantity: number | null;
  inventoryExpiryDaysValue: number;
  syncInventoryIngredient: (ingredient: Ingredient | null, ingredientQuery?: string) => void;
  submitInventory: (event: FormEvent<HTMLFormElement>) => Promise<void>;
  isCreatingInventory?: boolean;
};

export function IngredientInventoryOverlay(props: IngredientInventoryOverlayProps) {
  const tracksQuantity = tracksIngredientQuantity(props.selectedInventoryIngredient);
  const inventoryFormId = 'ingredient-inventory-overlay-form';
  const shouldShowIngredientPicker = !props.inventoryForm.ingredientLocked && !props.selectedInventoryIngredient;
  const ingredientSearch = useIngredientResourceSearch(props.inventoryForm.ingredientQuery, {
    enabled: shouldShowIngredientPicker,
    fallbackIngredients: props.ingredients,
  });

  const inventoryQuantityUnitOptions = useMemo(() => {
    const currentUnit = props.inventoryForm.unit || props.selectedInventoryIngredient?.default_unit || '个';
    const units = props.selectedInventoryIngredient
      ? [currentUnit, ...props.inventoryUnitOptions.map((option) => option.unit)]
      : [currentUnit];
    return units
      .filter((unit, index, list) => unit && list.indexOf(unit) === index)
      .map((unit) => ({ value: unit, label: unit }));
  }, [props.inventoryForm.unit, props.inventoryUnitOptions, props.selectedInventoryIngredient]);

  return (
    <WorkspaceModal
      title="登记这批库存"
      description="把这次买回来的这一批快速记下来。"
      closeLabel="关闭"
      closeAriaLabel="关闭"
      className="workspace-modal-wide inventory-restock-modal"
      onClose={props.closeOverlay}
      footerActions={
        <FormActions
          className="ingredients-restock-actions"
          primaryLabel={tracksQuantity ? '补入库存' : '确认已有'}
          primaryType="submit"
          primaryForm={inventoryFormId}
          primaryDisabled={!props.inventoryForm.ingredientId}
          isSubmitting={Boolean(props.isCreatingInventory)}
          secondaryLabel="取消"
          onSecondary={props.closeOverlay}
        />
      }
    >
      <form id={inventoryFormId} className="ingredients-restock-form" onSubmit={(event) => void props.submitInventory(event)}>
        <div className="ingredients-restock-scroll">
          {!props.inventoryForm.ingredientLocked &&
            !props.selectedInventoryIngredient &&
            props.quickRestockIngredients.length > 0 && (
              <section className="ingredients-restock-field-group ingredients-restock-selection-strip">
                <div className="ingredients-restock-field-head">
                  <span>最近常补</span>
                  <p className="subtle">常用食材点一下就行。</p>
                </div>
                <div className="ingredients-restock-choice-row">
                  {props.quickRestockIngredients.map((ingredient) => {
                    const imageUrl = resolveMediaUrl(ingredient.image, 'thumb');
                    return (
                      <button
                        key={ingredient.id}
                        type="button"
                        className={
                          props.inventoryForm.ingredientId === ingredient.id
                            ? 'ingredients-restock-quick-item active'
                            : 'ingredients-restock-quick-item'
                        }
                        onClick={() => props.syncInventoryIngredient(ingredient, ingredient.name)}
                      >
                        <div className="ingredients-restock-quick-avatar">
                          <MediaWithPlaceholder src={imageUrl} alt="" />
                        </div>
                        <span>{ingredient.name}</span>
                      </button>
                    );
                  })}
                </div>
              </section>
            )}

          {shouldShowIngredientPicker && (
            <div className="ingredients-restock-search-field">
              <span>食材</span>
              <SearchableResourceSelect
                ariaLabel="选择食材"
                placeholder="搜索或选择食材"
                value={props.inventoryForm.ingredientId}
                query={props.inventoryForm.ingredientQuery}
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
                emptyText={ingredientSearch.isSearching ? '正在搜索...' : '没有匹配的食材'}
                onSearchCompositionStart={ingredientSearch.onCompositionStart}
                onSearchCompositionEnd={ingredientSearch.onCompositionEnd}
                onQueryChange={(nextQuery) => {
                  const ingredient = ingredientSearch.findIngredientByName(nextQuery);
                  props.syncInventoryIngredient(ingredient, nextQuery);
                }}
                onLoadMore={() => {
                  if (ingredientSearch.hasMore && !ingredientSearch.isFetchingNextPage) {
                    void ingredientSearch.fetchNextPage();
                  }
                }}
                onChange={(ingredientId) => {
                  const ingredient = ingredientSearch.findIngredientById(ingredientId);
                  props.syncInventoryIngredient(ingredient, ingredient?.name ?? '');
                }}
              />
            </div>
          )}

          <IngredientRestockIdentitySection
            ingredient={props.selectedInventoryIngredient}
            previewUrl={props.selectedIngredientPreview}
            meta={props.selectedIngredientMeta}
            badgeLabel={props.inventoryForm.ingredientLocked ? '当前食材' : '已选食材'}
            canSwitch={!props.inventoryForm.ingredientLocked}
            onSwitch={() => props.syncInventoryIngredient(null, '')}
          />

          <IngredientRestockQuantitySection
            ingredient={props.selectedInventoryIngredient}
            quantity={props.inventoryForm.quantity}
            unit={props.inventoryForm.unit || props.selectedInventoryIngredient?.default_unit || '个'}
            unitOptions={inventoryQuantityUnitOptions}
            selectedUnit={props.selectedInventoryUnit}
            normalizedQuantity={props.inventoryNormalizedQuantity}
            onQuantityChange={(quantity) => props.setInventoryForm({ ...props.inventoryForm, quantity })}
            onUnitChange={(unit) => props.setInventoryForm({ ...props.inventoryForm, unit })}
          />

          <IngredientRestockPurchaseSection
            purchaseDate={props.inventoryForm.purchaseDate}
            purchaseDatePreset={props.inventoryForm.purchaseDatePreset}
            onChange={(patch) => {
              const resolvedPatch = resolvePurchaseDatePatch(patch);
              const purchaseDate = resolvedPatch.purchaseDate ?? props.inventoryForm.purchaseDate;
              props.setInventoryForm({
                ...props.inventoryForm,
                ...resolvedPatch,
                expiryDate:
                  props.inventoryForm.expiryInputMode === 'days'
                    ? resolveExpiryDateFromDays(purchaseDate, props.inventoryForm.expiryDays)
                    : props.inventoryForm.expiryDate,
              });
            }}
          />

          <IngredientRestockStorageSection
            storageLocation={props.inventoryForm.storageLocation}
            onChange={(storageLocation) => props.setInventoryForm({ ...props.inventoryForm, storageLocation })}
          />

          <IngredientRestockExpirySection
            expiryInputMode={props.inventoryForm.expiryInputMode}
            expiryDays={props.inventoryForm.expiryDays}
            expiryDate={props.inventoryForm.expiryDate}
            purchaseDate={props.inventoryForm.purchaseDate}
            defaultExpiryDays={props.selectedInventoryIngredient?.default_expiry_days}
            expiryDaysValue={props.inventoryExpiryDaysValue}
            onChange={(patch) => props.setInventoryForm({ ...props.inventoryForm, ...patch })}
          />

          <IngredientRestockAdvancedSection
            open={props.inventoryAdvancedOpen}
            status={props.inventoryForm.status}
            notes={props.inventoryForm.notes}
            onOpenChange={props.setInventoryAdvancedOpen}
            onChange={(patch) => props.setInventoryForm({ ...props.inventoryForm, ...patch })}
          />
        </div>

      </form>
    </WorkspaceModal>
  );
}
