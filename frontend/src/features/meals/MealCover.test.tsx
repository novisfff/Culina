// @vitest-environment jsdom

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { MediaAsset } from '../../api/types';
import { MealCover, selectMealCoverFoods } from './MealCover';

function media(id: string): MediaAsset {
  return {
    id,
    name: id,
    url: `/media/${id}.jpg`,
    source: 'upload',
    alt: id,
    created_at: '2026-07-17T10:00:00Z',
  };
}

describe('MealCover', () => {
  it('defines stable two, three and four-tile layouts with one-pixel dividers', () => {
    const styles = readFileSync(resolve(__dirname, '../../styles/08-meal-log.css'), 'utf8');
    const base = styles.match(/\.meal-cover \{([^}]*)\}/)?.[1] ?? '';
    const two = styles.match(/\.meal-cover-count-2 \{([^}]*)\}/)?.[1] ?? '';
    const three = styles.match(/\.meal-cover-count-3 \{([^}]*)\}/)?.[1] ?? '';
    const four = styles.match(/\.meal-cover-count-4 \{([^}]*)\}/)?.[1] ?? '';
    const threeLead = styles.match(/\.meal-cover-count-3 \.meal-cover-tile:first-child \{([^}]*)\}/)?.[1] ?? '';

    expect(base).toContain('overflow: hidden');
    expect(base).toContain('gap: 1px');
    expect(two).toContain('grid-template-columns: repeat(2, minmax(0, 1fr))');
    expect(three).toContain('grid-template-columns: repeat(2, minmax(0, 1fr))');
    expect(threeLead).toContain('grid-row: 1 / -1');
    expect(four).toContain('grid-template-columns: repeat(2, minmax(0, 1fr))');
  });

  it('preserves the system placeholder grid so its icon stays centered', () => {
    const styles = readFileSync(resolve(__dirname, '../../styles/08-meal-log.css'), 'utf8');
    const sizingSelectors = styles.match(/\.meal-cover-tile,[\s\S]*?\{/)?.[0] ?? '';

    expect(sizingSelectors).not.toContain('.meal-cover .media-placeholder');
  });

  it('prioritizes foods with covers and preserves order within each group', () => {
    const selected = selectMealCoverFoods([
      { id: 'rice', name: '米饭', cover: null },
      { id: 'greens', name: '青菜', cover: null },
      { id: 'fruit', name: '水果', cover: media('fruit') },
      { id: 'pork', name: '红烧肉', cover: media('pork') },
      { id: 'fish', name: '鱼', cover: media('fish') },
    ]);

    expect(selected.map((food) => food.id)).toEqual(['fruit', 'pork', 'fish', 'rice']);
  });

  it('shows one whole-cover placeholder when no food has an image', () => {
    render(
      <MealCover
        alt="晚餐：米饭、青菜"
        foods={[
          { id: 'rice', name: '米饭', cover: null },
          { id: 'greens', name: '青菜', cover: null },
        ]}
      />,
    );

    const cover = screen.getByRole('img', { name: '晚餐：米饭、青菜' });
    expect(cover).toHaveAttribute('data-meal-cover-mode', 'empty');
    expect(within(cover).getAllByTestId('meal-cover-empty-state')).toHaveLength(1);
  });

  it('uses the meal photo instead of food tiles when it loads', () => {
    render(
      <MealCover
        alt="晚餐记录"
        mealPhoto={media('meal-photo')}
        foods={[
          { id: 'rice', name: '米饭', cover: media('rice') },
          { id: 'greens', name: '青菜', cover: media('greens') },
        ]}
      />,
    );

    const cover = screen.getByRole('img', { name: '晚餐记录' });
    expect(cover).toHaveAttribute('data-meal-cover-mode', 'photo');
    expect(within(cover).getAllByRole('presentation')).toHaveLength(1);
  });

  it('falls back to the food mosaic when the meal photo fails', () => {
    render(
      <MealCover
        alt="晚餐记录"
        mealPhoto={media('meal-photo')}
        foods={[
          { id: 'rice', name: '米饭', cover: media('rice') },
          { id: 'greens', name: '青菜', cover: null },
          { id: 'soup', name: '汤', cover: media('soup') },
        ]}
      />,
    );

    const cover = screen.getByRole('img', { name: '晚餐记录' });
    fireEvent.error(within(cover).getByRole('presentation'));

    expect(cover).toHaveAttribute('data-meal-cover-mode', 'mosaic');
    expect(cover).toHaveAttribute('data-meal-cover-count', '3');
    expect(within(cover).getAllByTestId('meal-cover-tile')).toHaveLength(3);
    expect(within(cover).getAllByTestId('meal-cover-empty-state')).toHaveLength(1);
  });
});
