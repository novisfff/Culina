// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MealLog, Member } from '../../api/types';
import { MealEnrichmentModal } from './MealEnrichmentModal';
import type { MealSource } from './MealLogEnrichment';

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
  created_at: '2026-07-07T12:00:00Z',
  updated_at: '2026-07-07T12:00:00Z',
};

const members: Member[] = [];
const source: MealSource = { status: 'planned', label: '菜单计划' };

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

function renderModal(options: { open?: boolean; isUpdating?: boolean } = {}) {
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
        meal={meal}
        source={source}
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

    expect(view.textContent).toContain('补充这餐');
    expect(view.textContent).toContain('保存后，本次补充记录将会出现在记录时间线中');
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

    act(() => view.querySelector<HTMLDivElement>('.workspace-overlay-backdrop')?.click());
    act(() => view.querySelector<HTMLButtonElement>('.workspace-overlay-close')?.click());
    act(() => view.querySelector<HTMLButtonElement>('button.ui-form-actions-secondary')?.click());

    expect(onClose).not.toHaveBeenCalled();
  });
});
