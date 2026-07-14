import type { FormEvent } from 'react';
import type { Food, Ingredient } from '../../api/types';
import { resolveAssetUrl } from '../../lib/assets';
import { getIngredientUnitOptions } from '../../lib/ingredientUnits';
import { quantityTrackingLabel, tracksIngredientQuantity } from '../../lib/ingredientTracking';
import { WorkspaceOverlayFrame } from '../ui-kit';
import {
  parsePositiveNumber,
  resolveTouchDefaultValue,
  resolveTouchQuickValues,
  resolveTouchStep,
  type ShoppingDialogFormState,
} from './ingredientWorkspaceForms';
import { IngredientShoppingOverlay } from './IngredientShoppingOverlay';

type IngredientShoppingDialogProps = {
  open: boolean;
  closeOverlay: () => void;
  ingredients: Ingredient[];
  foods: Food[];
  shoppingForm: ShoppingDialogFormState;
  setShoppingForm: (next: ShoppingDialogFormState) => void;
  submitShopping: (event: FormEvent<HTMLFormElement>) => Promise<void>;
  isCreatingShopping?: boolean;
};

export function IngredientShoppingDialog(props: IngredientShoppingDialogProps) {
  if (!props.open) {
    return null;
  }

  const selectedShoppingIngredient =
    props.shoppingForm.targetType === 'ingredient' && props.shoppingForm.ingredientId
      ? props.ingredients.find((item) => item.id === props.shoppingForm.ingredientId) ?? null
      : null;
  const selectedShoppingFood =
    props.shoppingForm.targetType === 'food' && props.shoppingForm.foodId
      ? props.foods.find((item) => item.id === props.shoppingForm.foodId) ?? null
      : null;
  const shoppingIngredientUnitOptions = selectedShoppingIngredient
    ? getIngredientUnitOptions(selectedShoppingIngredient)
    : [];
  const selectedShoppingIngredientPreview = resolveAssetUrl(selectedShoppingIngredient?.image?.url);
  const selectedShoppingFoodPreview = resolveAssetUrl(selectedShoppingFood?.images?.[0]?.url);
  const selectedShoppingIngredientMeta = selectedShoppingIngredient
    ? [
        selectedShoppingIngredient.category || '未分类',
        quantityTrackingLabel(selectedShoppingIngredient),
        tracksIngredientQuantity(selectedShoppingIngredient)
          ? `默认 ${selectedShoppingIngredient.default_unit || '个'}`
          : '做菜不扣减数量',
        selectedShoppingIngredient.default_storage || '常温',
      ]
    : [];
  const selectedShoppingFoodMeta = selectedShoppingFood
    ? [
        selectedShoppingFood.category || '成品速食',
        selectedShoppingFood.storage_location || '常温',
        `默认 ${selectedShoppingFood.stock_unit || '份'}`,
      ]
    : [];
  const shoppingQuantityValue =
    parsePositiveNumber(props.shoppingForm.quantity) ??
    resolveTouchDefaultValue(props.shoppingForm.unit || '个', 'quantity');
  const shoppingQuantityStep = resolveTouchStep(props.shoppingForm.unit || '个');
  const shoppingQuantityQuickValues = resolveTouchQuickValues(
    props.shoppingForm.unit || '个',
    'quantity',
  );
  const closeIfAllowed = () => {
    if (!props.isCreatingShopping) {
      props.closeOverlay();
    }
  };

  return (
    <WorkspaceOverlayFrame
      rootClassName="ingredient-workspace-overlay-root"
      closeOnBackdrop={!props.isCreatingShopping}
      busy={Boolean(props.isCreatingShopping)}
      onClose={closeIfAllowed}
    >
      <IngredientShoppingOverlay
        closeOverlay={closeIfAllowed}
        ingredients={props.ingredients}
        foods={props.foods}
        shoppingForm={props.shoppingForm}
        setShoppingForm={props.setShoppingForm}
        selectedShoppingIngredient={selectedShoppingIngredient}
        selectedShoppingFood={selectedShoppingFood}
        selectedShoppingIngredientPreview={selectedShoppingIngredientPreview}
        selectedShoppingFoodPreview={selectedShoppingFoodPreview}
        selectedShoppingIngredientMeta={selectedShoppingIngredientMeta}
        selectedShoppingFoodMeta={selectedShoppingFoodMeta}
        shoppingIngredientUnitOptions={shoppingIngredientUnitOptions}
        shoppingQuantityValue={shoppingQuantityValue}
        shoppingQuantityStep={shoppingQuantityStep}
        shoppingQuantityQuickValues={shoppingQuantityQuickValues}
        submitShopping={props.submitShopping}
        isCreatingShopping={props.isCreatingShopping}
      />
    </WorkspaceOverlayFrame>
  );
}
