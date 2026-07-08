import { describe, expect, it } from 'vitest';
import type { Food, MediaAsset, Recipe } from '../../api/types';
import { resolveMobileSceneCoverSource } from './FoodMobileSceneModel';

const sceneAsset: MediaAsset = {
  id: 'media-scene',
  name: '场景封面',
  url: '/media/scene-original.jpg',
  source: 'upload',
  alt: '场景封面',
  variants: {
    card: {
      url: '/media/scene-card.jpg',
      width: 640,
      height: 420,
      content_type: 'image/jpeg',
      byte_size: 1200,
    },
  },
  created_at: '2026-06-01T10:00:00Z',
};

const foodAsset: MediaAsset = {
  ...sceneAsset,
  id: 'media-food',
  name: '食物图',
  url: '/media/food-original.jpg',
  variants: {
    card: {
      url: '/media/food-card.jpg',
      width: 640,
      height: 420,
      content_type: 'image/jpeg',
      byte_size: 1100,
    },
  },
};

const food: Food = {
  id: 'food-1',
  family_id: 'family-1',
  name: '番茄炒蛋',
  type: 'selfMade',
  category: '家常菜',
  flavor_tags: [],
  scene_tags: ['工作日晚餐'],
  suitable_meal_types: ['dinner'],
  source_name: '',
  purchase_source: '',
  scene: '',
  images: [foodAsset],
  notes: '',
  routine_note: '',
  price: null,
  rating: null,
  repurchase: null,
  expiry_date: null,
  stock_quantity: null,
  stock_unit: '',
  storage_location: '',
  favorite: false,
  recipe_id: null,
  created_at: '2026-06-01T10:00:00Z',
  updated_at: '2026-06-01T10:00:00Z',
};

describe('mobile food scene cover source', () => {
  it('prefers the configured scene media asset over food images', () => {
    const cover = resolveMobileSceneCoverSource({ imageAsset: sceneAsset, imageFood: food }, []);

    expect(cover.source).toBe('scene');
    expect(cover.asset?.id).toBe(sceneAsset.id);
    expect(cover.url).toContain('/media/scene-card.jpg');
  });

  it('prefers a configured scene image url over food images', () => {
    const cover = resolveMobileSceneCoverSource(
      { imageUrl: '/media/configured-scene.jpg', imageFood: food },
      [],
      (url) => `resolved:${url}`
    );

    expect(cover).toEqual({
      url: 'resolved:/media/configured-scene.jpg',
      asset: null,
      source: 'scene',
    });
  });

  it('falls back to the food image only when the scene has no configured cover', () => {
    const cover = resolveMobileSceneCoverSource({ imageFood: food }, []);

    expect(cover.source).toBe('food');
    expect(cover.asset?.id).toBe(foodAsset.id);
    expect(cover.url).toContain('/media/food-card.jpg');
  });

  it('returns fallback when neither scene nor food image exists', () => {
    const cover = resolveMobileSceneCoverSource({ imageFood: { ...food, images: [] } }, [] as Recipe[]);

    expect(cover).toEqual({ source: 'fallback' });
  });
});
