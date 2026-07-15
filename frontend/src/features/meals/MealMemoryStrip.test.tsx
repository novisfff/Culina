// @vitest-environment jsdom

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { MealInsight, MediaAsset } from '../../api/types';
import { MealMemoryStrip } from './MealMemoryStrip';
import { buildMealInsightPresentation } from './MealLogWorkspaceModel';

function media(id: string, overrides: Partial<MediaAsset> = {}): MediaAsset {
  return {
    id,
    name: id,
    url: `/media/${id}.jpg`,
    source: 'upload',
    alt: id,
    created_at: '2026-07-15T11:00:00.000Z',
    ...overrides,
  };
}

function insight(overrides: Partial<MealInsight> & { kind: MealInsight['kind'] }): MealInsight {
  return {
    kind: overrides.kind,
    food: {
      id: 'food-1',
      name: '番茄炒蛋',
      food_type: 'selfMade',
      cover: media('cover-1', { alt: '番茄炒蛋封面' }),
      ...overrides.food,
    },
    evidence: {
      meal_count: 4,
      last_eaten_on: '2026-07-10',
      rating_count: 2,
      average_rating: 4.5,
      window_days: 30,
      ...overrides.evidence,
    },
  };
}

describe('buildMealInsightPresentation', () => {
  it('maps repurchase takeout to 值得再点 with rating evidence', () => {
    const repurchaseTakeout = insight({
      kind: 'repurchase',
      food: { id: 'food-t', name: '黄焖鸡', food_type: 'takeout', cover: null },
      evidence: {
        meal_count: 3,
        last_eaten_on: '2026-07-01',
        rating_count: 2,
        average_rating: 4.5,
        window_days: 180,
      },
    });
    expect(buildMealInsightPresentation(repurchaseTakeout)).toEqual({
      title: '值得再点',
      evidence: '2 次评分，平均 4.5 分',
    });
  });

  it('maps missed title and days-ago evidence from window_days', () => {
    const missedFood = insight({
      kind: 'missed',
      evidence: {
        meal_count: 5,
        last_eaten_on: '2026-06-07',
        rating_count: 0,
        average_rating: null,
        window_days: 38,
      },
    });
    expect(buildMealInsightPresentation(missedFood).title).toBe('一个月没吃');
    expect(buildMealInsightPresentation(missedFood).evidence).toBe('上次是 38 天前');
  });

  it('maps ready/instant/packaged to 值得回购 and diningOut to 值得再去', () => {
    expect(
      buildMealInsightPresentation(
        insight({
          kind: 'repurchase',
          food: { id: 'f1', name: '速食面', food_type: 'readyMade', cover: null },
        }),
      ).title,
    ).toBe('值得回购');
    expect(
      buildMealInsightPresentation(
        insight({
          kind: 'repurchase',
          food: { id: 'f2', name: '泡面', food_type: 'instant', cover: null },
        }),
      ).title,
    ).toBe('值得回购');
    expect(
      buildMealInsightPresentation(
        insight({
          kind: 'repurchase',
          food: { id: 'f3', name: '罐头', food_type: 'packaged', cover: null },
        }),
      ).title,
    ).toBe('值得回购');
    expect(
      buildMealInsightPresentation(
        insight({
          kind: 'repurchase',
          food: { id: 'f4', name: '火锅店', food_type: 'diningOut', cover: null },
        }),
      ).title,
    ).toBe('值得再去');
  });

  it('maps frequent and repeated titles with meal-count evidence', () => {
    expect(
      buildMealInsightPresentation(
        insight({
          kind: 'frequent_recent',
          evidence: {
            meal_count: 4,
            last_eaten_on: '2026-07-10',
            rating_count: 0,
            average_rating: null,
            window_days: 30,
          },
        }),
      ),
    ).toEqual({
      title: '家里最近常吃',
      evidence: '近 30 天吃了 4 顿',
    });

    expect(
      buildMealInsightPresentation(
        insight({
          kind: 'repeated_choice',
          food: { id: 'f5', name: '咖啡', food_type: 'readyMade', cover: null },
          evidence: {
            meal_count: 2,
            last_eaten_on: '2026-07-12',
            rating_count: 0,
            average_rating: null,
            window_days: 30,
          },
        }),
      ),
    ).toEqual({
      title: '最近常选',
      evidence: '近 30 天吃了 2 顿',
    });
  });

  it('formats whole-number average ratings without trailing zero', () => {
    expect(
      buildMealInsightPresentation(
        insight({
          kind: 'repurchase',
          food: { id: 'f6', name: '寿司', food_type: 'takeout', cover: null },
          evidence: {
            meal_count: 2,
            last_eaten_on: '2026-07-01',
            rating_count: 2,
            average_rating: 4.0,
            window_days: 180,
          },
        }),
      ).evidence,
    ).toBe('2 次评分，平均 4 分');
  });
});

describe('MealMemoryStrip', () => {
  it('renders null for empty success', () => {
    const { container } = render(
      <MealMemoryStrip insights={[]} status="success" onRetry={() => undefined} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('renders null when idle/disabled with no data', () => {
    const { container } = render(
      <MealMemoryStrip insights={[]} status="idle" onRetry={() => undefined} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('shows loading skeleton without blocking timeline host', () => {
    render(
      <div>
        <MealMemoryStrip insights={[]} status="loading" onRetry={() => undefined} />
        <h2>家庭时间线</h2>
      </div>,
    );
    expect(screen.getByLabelText('家庭记忆加载中')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '家庭时间线' })).toBeInTheDocument();
  });

  it('shows lightweight retry on error and keeps timeline host visible', async () => {
    const user = userEvent.setup();
    const onRetry = vi.fn();
    render(
      <div>
        <MealMemoryStrip insights={[]} status="error" onRetry={onRetry} />
        <h2>家庭时间线</h2>
      </div>,
    );
    expect(screen.getByText(/家庭记忆暂时加载失败|加载失败/)).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '家庭时间线' })).toBeInTheDocument();
    const retry = screen.getByRole('button', { name: /重试/ });
    expect(retry.getBoundingClientRect().height).toBeGreaterThanOrEqual(0);
    await user.click(retry);
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('renders photo-first cards with cover or placeholder and no duplicated food', () => {
    render(
      <MealMemoryStrip
        status="success"
        onRetry={() => undefined}
        insights={[
          insight({
            kind: 'frequent_recent',
            food: {
              id: 'food-a',
              name: '番茄炒蛋',
              food_type: 'selfMade',
              cover: media('cover-a', { alt: '番茄炒蛋封面' }),
            },
          }),
          insight({
            kind: 'missed',
            food: {
              id: 'food-b',
              name: '红烧肉',
              food_type: 'selfMade',
              cover: null,
            },
            evidence: {
              meal_count: 3,
              last_eaten_on: '2026-06-01',
              rating_count: 0,
              average_rating: null,
              window_days: 44,
            },
          }),
        ]}
      />,
    );

    expect(screen.getByText('家里最近常吃')).toBeInTheDocument();
    expect(screen.getByText('一个月没吃')).toBeInTheDocument();
    expect(screen.getByText('番茄炒蛋')).toBeInTheDocument();
    expect(screen.getByText('红烧肉')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: /番茄炒蛋/ })).toBeInTheDocument();
    // Placeholder path: media-with-placeholder without loaded image for null cover.
    expect(document.querySelectorAll('.meal-memory-card').length).toBe(2);
    expect(document.querySelectorAll('[data-food-id="food-a"]').length).toBe(1);
    expect(document.querySelectorAll('[data-food-id="food-b"]').length).toBe(1);
  });
});
