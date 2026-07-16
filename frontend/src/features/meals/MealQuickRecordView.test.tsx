// @vitest-environment jsdom

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { MealLogCandidate, MediaAsset } from '../../api/types';
import {
  MealQuickRecordView,
  type MealQuickRecordViewProps,
} from './MealQuickRecordView';

function media(id: string, overrides: Partial<MediaAsset> = {}): MediaAsset {
  return {
    id,
    name: id,
    url: `/media/${id}.jpg`,
    source: 'upload',
    alt: id,
    created_at: '2026-07-15T10:00:00Z',
    ...overrides,
  };
}

function candidate(id: string, overrides: Partial<MealLogCandidate> = {}): MealLogCandidate {
  return {
    meal_log_id: id,
    row_version: 2,
    date: '2026-07-15',
    meal_type: 'lunch',
    created_at: '2026-07-15T04:00:00Z',
    foods: [{ food_id: 'food-a', name: '番茄炒蛋', food_type: 'selfMade' }],
    preview_media: null,
    photo_count: 0,
    ...overrides,
  };
}

function renderQuick(overrides: Partial<MealQuickRecordViewProps> = {}) {
  const props: MealQuickRecordViewProps = {
    open: true,
    prefilledFood: {
      food_id: 'food-1',
      name: '青椒肉丝',
      cover: media('cover-1', { alt: '青椒肉丝' }),
    },
    date: '2026-07-15',
    mealType: 'lunch',
    dateOptions: ['2026-07-15', '2026-07-16'],
    candidates: [],
    selectedCandidateId: null,
    candidateMode: 'none',
    target: { kind: 'new' },
    busy: false,
    error: null,
    onClose: vi.fn(),
    onDateChange: vi.fn(),
    onMealTypeChange: vi.fn(),
    onTargetChange: vi.fn(),
    onSubmit: vi.fn(),
    ...overrides,
  };
  const view = render(<MealQuickRecordView {...props} />);
  return { ...view, props };
}

describe('MealQuickRecordView', () => {
  it('shows prefilled food hero without re-search controls', () => {
    renderQuick();

    expect(screen.getByText('青椒肉丝')).toBeVisible();
    expect(screen.getByRole('img', { name: /青椒肉丝/ })).toBeVisible();
    expect(screen.queryByRole('combobox', { name: /搜索/ })).not.toBeInTheDocument();
    expect(screen.queryByPlaceholderText(/搜索/)).not.toBeInTheDocument();
  });

  it('has no stock toggle or quantity contract', () => {
    renderQuick();

    expect(screen.queryByText(/同步扣减库存|扣减数量|库存/)).not.toBeInTheDocument();
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    expect(document.querySelector('input[type="number"]')).toBeNull();
  });

  it('shows candidate confirmation and final combination preview', () => {
    const one = candidate('meal-1', {
      preview_media: media('meal-photo', { alt: '今晚这顿' }),
      foods: [
        { food_id: 'food-a', name: '番茄炒蛋', food_type: 'selfMade' },
        { food_id: 'food-b', name: '青菜', food_type: 'selfMade' },
      ],
    });
    renderQuick({
      mealType: 'dinner',
      candidates: [one],
      candidateMode: 'single',
      selectedCandidateId: 'meal-1',
      target: { kind: 'existing', meal_log_id: 'meal-1', expected_row_version: 2 },
    });

    expect(screen.getByText('和今晚这顿一起记吗？')).toBeVisible();
    expect(screen.getByText('番茄炒蛋、青菜')).toBeVisible();
    expect(screen.getByText(/这顿会记成/)).toBeVisible();
    expect(screen.getByText(/番茄炒蛋、青菜、青椒肉丝/)).toBeVisible();
    expect(document.querySelectorAll('.workspace-overlay-root').length).toBe(1);
  });

  it('disables submit while busy and blocks Escape close', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const onSubmit = vi.fn();
    renderQuick({ busy: true, onClose, onSubmit });

    const submit = screen.getByRole('button', { name: /记下|记录|处理中/ });
    expect(submit).toBeDisabled();
    await user.click(submit);
    expect(onSubmit).not.toHaveBeenCalled();

    await user.keyboard('{Escape}');
    expect(onClose).not.toHaveBeenCalled();
  });

  it('disables only submit while candidates are unresolved and still allows close', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const onSubmit = vi.fn();
    renderQuick({ submitDisabled: true, onClose, onSubmit });

    const submit = screen.getByRole('button', { name: '记下这餐' });
    const cancel = screen.getByRole('button', { name: '取消' });
    expect(submit).toBeDisabled();
    expect(cancel).toBeEnabled();

    await user.click(cancel);
    expect(onClose).toHaveBeenCalledTimes(1);
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(2);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('renders server errors inline', () => {
    renderQuick({ error: '这顿饭刚被家人更新，请重新确认' });
    expect(screen.getByRole('alert')).toHaveTextContent('这顿饭刚被家人更新，请重新确认');
  });

  it('uses meal-quick-record class prefixes for touch targets', () => {
    renderQuick({
      candidates: [candidate('meal-1')],
      candidateMode: 'single',
      selectedCandidateId: 'meal-1',
      target: { kind: 'existing', meal_log_id: 'meal-1', expected_row_version: 2 },
      mealType: 'dinner',
    });

    expect(screen.getByRole('button', { name: '记在一起' }).className).toMatch(/meal-composer-/);
    expect(document.querySelector('.meal-quick-record-form')).not.toBeNull();
    expect(document.querySelector('.meal-quick-record-actions')).not.toBeNull();
  });
});
