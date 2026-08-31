import type { Food, MediaAsset, Recipe } from '../../api/types/food';
import { resolveAssetUrl, resolveMediaUrl } from '../../lib/assets';
import { getFoodCoverAsset } from '../../lib/ui';
import { getFoodSceneTags } from './FoodWorkspaceHelpers';
import type { FoodSceneCardView } from './useFoodSceneState';

export function getMobileFoodSceneFilterState(sceneName: string) {
  return { search: '', lensFilter: 'all' as const, typeFilter: 'all' as const, mealFilter: 'all' as const, sceneFilter: sceneName, governanceIssueFilter: 'all' as const };
}

export function getMobileDefaultFoodSceneCardMedia(sceneName: string, foods: Food[], sceneCards: Array<Pick<FoodSceneCardView, 'name' | 'count' | 'imageUrl' | 'imageAsset'>>, fallbackIndex: number) {
  const managedScene = sceneCards.find((scene) => scene.name === sceneName);
  return {
    count: managedScene?.count ?? foods.filter((food) => getFoodSceneTags(food).includes(sceneName)).length,
    imageFood: foods.find((food) => getFoodSceneTags(food).includes(sceneName)) ?? foods[fallbackIndex] ?? foods[0],
    imageUrl: managedScene?.imageUrl,
    imageAsset: managedScene?.imageAsset,
  };
}

export type MobileSceneCoverInput = {
  imageAsset?: MediaAsset | null;
  imageUrl?: string;
  imageFood?: Food;
};

export type MobileSceneCoverSource = {
  url?: string;
  asset?: MediaAsset | null;
  source: 'scene' | 'food' | 'fallback';
};

export function resolveMobileSceneCoverSource(
  item: MobileSceneCoverInput,
  recipes: Recipe[],
  resolveConfiguredUrl: (url: string) => string | undefined = resolveAssetUrl
): MobileSceneCoverSource {
  const sceneUrl = resolveMediaUrl(item.imageAsset, 'card') ?? (item.imageUrl ? resolveConfiguredUrl(item.imageUrl) : undefined);
  if (sceneUrl) {
    return { url: sceneUrl, asset: item.imageAsset ?? null, source: 'scene' };
  }

  const foodAsset = item.imageFood ? getFoodCoverAsset(item.imageFood, recipes) : null;
  const foodUrl = resolveMediaUrl(foodAsset, 'card');
  if (foodUrl) {
    return { url: foodUrl, asset: foodAsset, source: 'food' };
  }

  return { source: 'fallback' };
}
