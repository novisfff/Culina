// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MealLog, Member } from '../../api/types';
import { MealEnrichmentModal } from './MealEnrichmentModal';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

const meal: MealLog = {
  id: 'meal-1',
  family_id: 'family-1',
  date: '2026-07-07',
  meal_type: 'dinner',
  food_entries: [{ id: 'entry-1', food_id: 'food-1', food_name: '番茄炒蛋', servings: 1, note: '', rating: null }],
  participant_user_ids: [],
  notes: '',
  mood: '',
  photos: [],
  deduction_suggestions: [],
  row_version: 1,
  created_at: '2026-07-07T12:00:00Z',
  updated_at: '2026-07-07T12:00:00Z',
};

const members: Member[] = [];

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

function renderModal(options: { open?: boolean; isUpdating?: boolean; meal?: MealLog } = {}) {
  const onClose = vi.fn();
  const open = options.open ?? true;
  const isUpdating = options.isUpdating ?? false;
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  act(() => {
    root?.render(
      <MealEnrichmentModal
        open={open}
        meal={options.meal ?? meal}
        members={members}
        isUpdating={isUpdating}
        updateMealLog={vi.fn(async () => undefined)}
        onClose={onClose}
        overlayRootClassName="home-dashboard-overlay-root"
        formId="test-meal-enrichment-form"
      />,
    );
  });
  return { onClose, view: container };
}

describe('MealEnrichmentModal', () => {
  it('wraps MealEnrichmentForm with the shared modal footer', () => {
    const { view } = renderModal();

    expect(view.textContent).toContain('编辑这顿');
    expect(view.textContent).toContain('保存后会更新这顿的评价、家人、照片和评论');
    expect(view.querySelector('.workspace-overlay-root.home-dashboard-overlay-root')).not.toBeNull();
    expect(view.querySelector<HTMLButtonElement>('button.ui-form-actions-primary')?.getAttribute('form')).toBe(
      'test-meal-enrichment-form',
    );
  });

  it('renders nothing when closed', () => {
    const { view } = renderModal({ open: false });
    expect(view.textContent).toBe('');
  });

  it('keeps the modal open while an update is submitting', () => {
    const { onClose, view } = renderModal({ isUpdating: true });

    expect(view.querySelector('[role="status"]')?.textContent).toContain('正在保存餐食记录');
    expect(view.querySelector<HTMLButtonElement>('.workspace-overlay-close')?.disabled).toBe(true);
    act(() => view.querySelector<HTMLDivElement>('.workspace-overlay-backdrop')?.click());
    act(() => view.querySelector<HTMLButtonElement>('.workspace-overlay-close')?.click());
    act(() => view.querySelector<HTMLButtonElement>('button.ui-form-actions-secondary')?.click());

    expect(onClose).not.toHaveBeenCalled();
  });
});
