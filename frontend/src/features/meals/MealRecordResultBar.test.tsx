// @vitest-environment jsdom

import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MealLog, MediaAsset } from '../../api/types';
import {
  MealRecordResultBar,
  type MealRecordResultBarProps,
} from './MealRecordResultBar';
import type { MealRecordResult } from './useMealRecordResultState';

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

function mealLog(overrides: Partial<MealLog> = {}): MealLog {
  return {
    id: 'meal-1',
    family_id: 'family-1',
    date: '2026-07-15',
    meal_type: 'dinner',
    food_entries: [
      {
        id: 'entry-1',
        food_id: 'food-1',
        food_name: '番茄炒蛋',
        servings: 1,
        note: '',
        rating: null,
      },
    ],
    participant_user_ids: ['user-1'],
    notes: '',
    mood: '',
    photos: [],
    deduction_suggestions: [],
    row_version: 3,
    created_at: '2026-07-15T11:00:00.000Z',
    updated_at: '2026-07-15T11:00:00.000Z',
    ...overrides,
  };
}

function result(overrides: Partial<MealRecordResult> = {}): MealRecordResult {
  return {
    source: 'immediate',
    operationId: 'op-1',
    mealLogId: 'meal-1',
    foods: [
      {
        food_id: 'food-1',
        name: '番茄炒蛋',
        food_type: 'selfMade',
        cover: media('food-cover', { alt: '番茄炒蛋封面' }),
      },
    ],
    previewMedia: media('meal-photo', { alt: '番茄炒蛋' }),
    revertibleUntil: '2026-07-15T11:15:00.000Z',
    canRevert: true,
    mealLog: mealLog(),
    rowVersion: 3,
    canRate: true,
    ...overrides,
  };
}

function renderBar(overrides: Partial<MealRecordResultBarProps> = {}) {
  const props: MealRecordResultBarProps = {
    result: result(),
    isReverting: false,
    revertError: null,
    rateError: null,
    onRevert: vi.fn(async () => undefined),
    onView: vi.fn(),
    onRate: vi.fn(async () => undefined),
    now: new Date('2026-07-15T11:05:00.000Z'),
    ...overrides,
  };
  const view = render(<MealRecordResultBar {...props} />);
  return { ...view, props };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('MealRecordResultBar', () => {
  it('shows 已记下, food image/name, undo and view actions', () => {
    renderBar();
    expect(screen.getByText('已记下')).toBeVisible();
    expect(screen.getByText('番茄炒蛋')).toBeVisible();
    expect(screen.getByRole('img', { name: /番茄炒蛋/ })).toBeVisible();
    expect(screen.getByRole('button', { name: '撤销' })).toBeVisible();
    expect(screen.getByRole('button', { name: '查看记录' })).toBeVisible();
  });

  it('shows compact rating only when full MealLog/version exists', () => {
    const { rerender, props } = renderBar();
    const slider = screen.getByRole('slider', { name: '评分' });
    expect(slider).toBeVisible();
    expect(slider).toHaveAttribute('aria-valuemin', '0.5');
    expect(slider).toHaveAttribute('aria-valuenow', '0.5');
    expect(slider).toHaveAttribute('aria-valuetext', '尚未评分');

    rerender(
      <MealRecordResultBar
        {...props}
        result={result({
          source: 'restored',
          canRate: false,
          mealLog: null,
          rowVersion: null,
        })}
      />,
    );
    expect(screen.queryByRole('slider', { name: '评分' })).not.toBeInTheDocument();
  });

  it('leaving rating blank creates no state', async () => {
    const user = userEvent.setup();
    const onRate = vi.fn(async () => undefined);
    renderBar({ onRate });
    const clear = screen.queryByRole('button', { name: /清空|跳过|不评分/ });
    if (clear) {
      await user.click(clear);
    }
    expect(onRate).not.toHaveBeenCalled();
    for (const debt of ['未评分', '待补充', '基础记录']) {
      expect(screen.queryByText(debt)).not.toBeInTheDocument();
    }
  });

  it('disables undo while submitting and keeps the bar mounted', async () => {
    const user = userEvent.setup();
    let resolveRevert: (() => void) | undefined;
    const onRevert = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveRevert = resolve;
        }),
    );
    const { rerender, props } = renderBar({ onRevert, isReverting: false });
    await user.click(screen.getByRole('button', { name: '撤销' }));
    expect(onRevert).toHaveBeenCalledTimes(1);

    rerender(<MealRecordResultBar {...props} isReverting />);
    expect(screen.getByRole('button', { name: '撤销' })).toBeDisabled();
    expect(screen.getByText('已记下')).toBeVisible();
    resolveRevert?.();
  });

  it('computes countdown from server deadline and maps expired undo copy', () => {
    renderBar({
      result: result({
        canRevert: false,
        revertibleUntil: '2026-07-15T11:00:00.000Z',
      }),
      now: new Date('2026-07-15T11:20:00.000Z'),
    });
    expect(screen.queryByRole('button', { name: '撤销' })).not.toBeInTheDocument();
    expect(screen.getByText(/已过撤销时限|不可撤销/)).toBeVisible();
  });

  it('shows remaining undo window while still revertible', () => {
    renderBar({
      now: new Date('2026-07-15T11:05:00.000Z'),
      result: result({ revertibleUntil: '2026-07-15T11:15:00.000Z', canRevert: true }),
    });
    expect(screen.getByText(/还可撤销/)).toBeVisible();
  });

  it('surfaces revert and rate errors without removing the result', () => {
    renderBar({
      revertError: '撤销失败，请重试',
      rateError: '评分失败，请重试',
    });
    expect(screen.getByText('撤销失败，请重试')).toBeVisible();
    expect(screen.getByText('评分失败，请重试')).toBeVisible();
    expect(screen.getByText('已记下')).toBeVisible();
  });

  it('delegates view and rating to shared state without owning mutations', async () => {
    const user = userEvent.setup();
    const onView = vi.fn();
    const onRate = vi.fn(async () => undefined);
    renderBar({ onView, onRate });
    await user.click(screen.getByRole('button', { name: '查看记录' }));
    expect(onView).toHaveBeenCalledTimes(1);

    const slider = screen.getByRole('slider', { name: '评分' });
    Object.defineProperty(slider, 'getBoundingClientRect', {
      value: () => ({ left: 0, width: 100, top: 0, height: 20, right: 100, bottom: 20 }),
    });
    await act(async () => {
      const pointerDown = new Event('pointerdown', { bubbles: true });
      Object.defineProperty(pointerDown, 'clientX', { value: 80 });
      slider.dispatchEvent(pointerDown);
    });
    expect(onRate).toHaveBeenCalled();
  });

  it('changes rating with arrow keys in half-star steps', async () => {
    const user = userEvent.setup();
    const onRate = vi.fn(async () => undefined);
    renderBar({ onRate });
    const slider = screen.getByRole('slider', { name: '评分' });
    slider.focus();
    await user.keyboard('{ArrowRight}');
    expect(onRate).toHaveBeenCalledWith(0.5);
    await user.keyboard('{ArrowRight}');
    expect(onRate).toHaveBeenCalledWith(1);
    await user.keyboard('{End}');
    expect(onRate).toHaveBeenCalledWith(5);
    await user.keyboard('{Home}');
    expect(onRate).toHaveBeenCalledWith(0.5);
    expect(onRate).not.toHaveBeenCalledWith(0);
  });

  it('keeps result actions out of compact touch sizing', () => {
    renderBar({ onDismiss: vi.fn() });

    for (const name of ['撤销', '查看记录', '关闭']) {
      expect(screen.getByRole('button', { name })).not.toHaveClass('button-compact');
    }
  });

  it('renders quiet dismiss and calls onDismiss', async () => {
    const user = userEvent.setup();
    const onDismiss = vi.fn();
    renderBar({ onDismiss });
    await user.click(screen.getByRole('button', { name: '关闭' }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});
