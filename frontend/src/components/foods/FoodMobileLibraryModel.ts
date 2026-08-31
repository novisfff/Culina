import type { Food, FoodScene } from '../../api/types/food';
import { getFoodSceneTags } from './FoodWorkspaceHelpers';
import { getMobileDefaultFoodSceneCardMedia } from './FoodMobileSceneModel';
import type { FoodSceneCardView } from './useFoodSceneState';

export type MobileCookingFilter = 'all' | 'ready' | 'shortage';

export type MobileSceneCard = {
  key: string;
  title: string;
  count: number;
  imageFood?: Food;
  imageUrl?: string;
  imageAsset?: FoodScene['image'];
};

export function buildMobileSceneExploreCards(args: {
  foods: Food[];
  sceneCards: FoodSceneCardView[];
  defaultScenes: Array<{ key: string; title: string; fallbackIndex: number }>;
}): MobileSceneCard[] {
  const defaults = args.defaultScenes.map((scene) => ({
    key: scene.key,
    title: scene.title,
    ...getMobileDefaultFoodSceneCardMedia(scene.title, args.foods, args.sceneCards, scene.fallbackIndex),
  }));
  return [
    ...defaults,
    ...args.sceneCards
      .filter((scene) => !defaults.some((card) => card.title === scene.name))
      .map((scene) => ({
        key: `scene-${scene.name}`,
        title: scene.name,
        count: scene.count,
        imageFood: args.foods.find((food) => getFoodSceneTags(food).includes(scene.name)) ?? args.foods[0],
        imageUrl: scene.imageUrl,
        imageAsset: scene.imageAsset,
      })),
  ];
}

export function paginateMobileSceneCards<T>(cards: T[], pageSize = 2): T[][] {
  return Array.from({ length: Math.ceil(cards.length / pageSize) || 1 }, (_, index) => cards.slice(index * pageSize, index * pageSize + pageSize));
}

export function filterMobileLibraryFoods(
  foods: Food[],
  cookingFilter: MobileCookingFilter,
  getSummary: (food: Food) => { isReady: boolean; shortagePreview: unknown[] } | null,
) {
  if (cookingFilter === 'all') return foods;
  return foods.filter((food) => {
    const summary = getSummary(food);
    if (!summary) return false;
    return cookingFilter === 'ready' ? summary.isReady : summary.shortagePreview.length > 0;
  });
}

export type MobileFilterTab = {
  label: string;
  active: boolean;
  onClick: () => void;
};

export function buildMobileFilterResetKey(values: Array<string | number | null | undefined>) {
  return values.join('|');
}
