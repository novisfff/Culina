import type { Food, FoodType } from '../../api/types/food';
import { normalizeFoodType } from './FoodWorkspaceHelpers';
import type { RecipeCardViewModel } from '../recipes/workspaceModel';

type RecipeCard = RecipeCardViewModel;

export function useFoodEditorNavigation(args: {
  resetFoodImage: () => void;
  resetRecipeImage: () => void;
  openCreate: (type: FoodType) => void;
  openEdit: (food: Food) => void;
  recipeCards: RecipeCard[];
  recipeEditorOpenCreate: () => void;
  recipeEditorOpenEdit: (card: RecipeCard) => void;
  setRecipeEditorOpen: (open: boolean) => void;
  closeDetail: () => void;
}) {
  function handleOpenCreate(type: FoodType = 'takeout') {
    args.resetFoodImage();
    args.resetRecipeImage();
    if (type === 'selfMade') args.recipeEditorOpenCreate();
    args.openCreate(type);
  }

  function handleOpenEdit(food: Food) {
    args.resetFoodImage();
    args.resetRecipeImage();
    if (normalizeFoodType(food) === 'selfMade' && food.recipe_id) {
      const card = args.recipeCards.find((item) => item.recipe.id === food.recipe_id);
      if (card) args.recipeEditorOpenEdit(card);
    }
    args.openEdit(food);
  }

  function handleOpenRecipeEditorDirectly(food: Food) {
    if (!food.recipe_id) return false;
    const card = args.recipeCards.find((item) => item.recipe.id === food.recipe_id);
    if (!card) return false;
    args.resetRecipeImage();
    args.recipeEditorOpenEdit(card);
    args.setRecipeEditorOpen(true);
    args.closeDetail();
    return true;
  }

  function closeFoodRecipeEditor() {
    args.setRecipeEditorOpen(false);
    args.resetRecipeImage();
  }

  return { handleOpenCreate, handleOpenEdit, handleOpenRecipeEditorDirectly, closeFoodRecipeEditor };
}
