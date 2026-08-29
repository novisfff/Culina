import { describe, expect, it } from 'vitest';
import {
  buildMobileFilterResetKey,
  buildMobileSceneExploreCards,
  filterMobileLibraryFoods,
  paginateMobileSceneCards,
} from './FoodMobileLibraryModel';

describe('FoodMobileLibraryModel', () => {
  it('keeps default scenes first and omits duplicate managed scenes', () => {
    const foods = [{ id: 'food-1', name: '番茄炒蛋' }] as never[];
    const cards = [
      { name: '家常', count: 3, imageUrl: '/home.jpg', imageAsset: null },
      { name: '早餐', count: 1, imageUrl: '/breakfast.jpg', imageAsset: null },
    ] as never[];

    const result = buildMobileSceneExploreCards({
      foods,
      sceneCards: cards,
      defaultScenes: [{ key: 'home', title: '家常', fallbackIndex: 0 }],
    });

    expect(result.map((item) => item.title)).toEqual(['家常', '早餐']);
    expect(result[0]?.count).toBe(3);
  });

  it('paginates cards into stable two-item pages', () => {
    expect(paginateMobileSceneCards([1, 2, 3, 4, 5])).toEqual([[1, 2], [3, 4], [5]]);
    expect(paginateMobileSceneCards([])).toEqual([[]]);
  });

  it('filters cooking readiness without mutating the source list', () => {
    const foods = [{ id: 'ready' }, { id: 'shortage' }, { id: 'unknown' }] as never[];
    const summary = (food: { id: string }) =>
      food.id === 'ready'
        ? { isReady: true, shortagePreview: [] }
        : food.id === 'shortage'
          ? { isReady: false, shortagePreview: ['鸡蛋'] }
          : null;

    expect(filterMobileLibraryFoods(foods, 'ready', summary).map((food) => food.id)).toEqual(['ready']);
    expect(filterMobileLibraryFoods(foods, 'shortage', summary).map((food) => food.id)).toEqual(['shortage']);
    expect(filterMobileLibraryFoods(foods, 'all', summary)).toBe(foods);
  });

  it('builds reset keys from the active filter tuple', () => {
    expect(buildMobileFilterResetKey(['', 'all', 'ready'])).toBe('|all|ready');
  });
});
