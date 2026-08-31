import type { Food, FoodScene, Recipe } from '../../api/types/food';
import type { Ingredient } from '../../api/types/recipe';
import { resolveAssetUrl } from '../../lib/assets';
import { getFoodCover, getImagePreview, splitTags } from '../../lib/ui';
import { buildRecipeImagePayload, type RecipeDraftIngredient, type RecipeFormState } from '../recipes/RecipeWorkspaceModel';
import { getFoodEditorProfile } from './FoodWorkspaceHelpers';
import { buildFoodEditorSceneTagOptions, buildRecipeEditorSceneTagOptions } from './FoodWorkspaceViewModel';
import { buildFoodEditorCompletionState, buildRecipeEditorCompletionState } from './FoodEditorProjectionModel';
import type { FoodFormState } from './FoodWorkspaceModel';

export function buildFoodWorkspaceEditorViewModel(args: {
  form: FoodFormState;
  editingFood: Food | null;
  recipes: Recipe[];
  foods: Food[];
  foodScenes: FoodScene[];
  editorSceneTags: string[];
  recipeForm: RecipeFormState;
  ingredientRows: RecipeDraftIngredient[];
  ingredients: Ingredient[];
  view: 'list' | 'create' | 'edit';
  isSavingFood: boolean;
  isCreatingRecipe: boolean;
  isUpdatingRecipe: boolean;
}) {
  const currentRecipe = args.recipes.find((recipe) => recipe.id === args.form.recipeId);
  const isSelfMade = args.form.type === 'selfMade';
  const editorCompletion = buildFoodEditorCompletionState({ form: args.form, editingFood: args.editingFood, recipes: args.recipes });
  const recipeCompletion = buildRecipeEditorCompletionState({
    title: args.recipeForm.title,
    servings: args.recipeForm.servings,
    ingredientRows: args.ingredientRows,
    steps: args.recipeForm.steps,
    hasCover: Boolean(getImagePreview(args.recipeForm.images)),
  });
  const canSaveRecipeEditorDraft = Boolean(args.recipeForm.title.trim() && recipeCompletion.ingredientCount > 0);
  const foodEditorSubmitLabel = isSelfMade
    ? args.view === 'create' ? '保存家常菜谱' : '保存菜谱及食物信息'
    : args.view === 'create' ? '保存食物' : '保存修改';
  const editorSceneTags = splitTags(args.recipeForm.sceneTags);
  return {
    currentRecipe,
    isSelfMade,
    editorProfile: getFoodEditorProfile(args.form.type),
    editorCompletionItems: editorCompletion.items,
    editorCompletedCount: editorCompletion.completedCount,
    editorCompletionPercent: editorCompletion.percent,
    availableSceneTagOptions: buildFoodEditorSceneTagOptions({ foodScenes: args.foodScenes, foods: args.foods, editorSceneTags: args.editorSceneTags }).filter((tag) => !args.editorSceneTags.includes(tag)),
    editorRecipeCover: currentRecipe?.images[0]?.url ?? (args.editingFood ? getFoodCover(args.editingFood, args.recipes) : undefined),
    editorRecipeMeta: currentRecipe ? `${currentRecipe.ingredient_items.length} 种食材 · ${currentRecipe.steps.length} 步` : '还没有菜谱',
    canSubmit: !args.isSavingFood && !args.isCreatingRecipe && !args.isUpdatingRecipe && (!isSelfMade || Boolean(args.form.recipeId) || canSaveRecipeEditorDraft),
    foodEditorSubmitLabel,
    recipeEditorSceneTags: editorSceneTags,
    recipeEditorCoverAsset: getImagePreview(args.recipeForm.images),
    recipeEditorCoverUrl: resolveAssetUrl(getImagePreview(args.recipeForm.images)?.url),
    recipeEditorCompletionItems: recipeCompletion.items,
    recipeEditorCompletionPercent: recipeCompletion.percent,
    recipeEditorIngredientCount: recipeCompletion.ingredientCount,
    recipeEditorStepCount: recipeCompletion.stepCount,
    recipeEditorSceneSelectOptions: buildRecipeEditorSceneTagOptions({ foodScenes: args.foodScenes, recipes: args.recipes }),
    recipeEditorImagePayload: buildRecipeImagePayload(args.recipeForm, args.ingredientRows, args.ingredients),
    recipeEditorSubmitDisabled: Boolean(args.isCreatingRecipe || args.isUpdatingRecipe),
  };
}
