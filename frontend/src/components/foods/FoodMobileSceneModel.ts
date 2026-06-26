import type { Food, MediaAsset, Recipe } from '../../api/types';
import { resolveAssetUrl, resolveMediaUrl } from '../../lib/assets';
import { getFoodCoverAsset } from '../../lib/ui';

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
