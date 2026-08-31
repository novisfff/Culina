import type { ComponentProps } from 'react';
import { FoodShoppingDialog } from './FoodShoppingDialog';
import { RecipeShoppingDialog } from '../recipes/RecipeShoppingDialog';

type FoodDialogProps = ComponentProps<typeof FoodShoppingDialog>;
type RecipeDialogProps = ComponentProps<typeof RecipeShoppingDialog>;

export type FoodWorkspaceShoppingOverlaysProps = {
  food: FoodDialogProps['food'];
  foodShopping: (Omit<FoodDialogProps, 'food'> & { open: boolean }) | null;
  recipeShopping: (RecipeDialogProps & { open: boolean }) | null;
};

export function FoodWorkspaceShoppingOverlays(props: FoodWorkspaceShoppingOverlaysProps) {
  const renderFoodDialog = () => {
    if (!props.foodShopping?.open) return null;
    const { open: _open, ...dialog } = props.foodShopping;
    return <FoodShoppingDialog food={props.food} {...dialog} />;
  };
  const renderRecipeDialog = () => {
    if (!props.recipeShopping?.open) return null;
    const { open: _open, ...dialog } = props.recipeShopping;
    return <RecipeShoppingDialog {...dialog} />;
  };
  return <>
    {renderFoodDialog()}
    {renderRecipeDialog()}
  </>;
}
