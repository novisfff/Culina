// @vitest-environment jsdom

import { act, useEffect, useState, type Dispatch, type SetStateAction } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  Ingredient,
  IngredientTrackingModeTransitionRequest,
} from '../../api/types';
import { defaultIngredientForm, type IngredientCreateFormState, type InventoryDrawerFormState } from './ingredientWorkspaceForms';
import { useIngredientEditorState } from './useIngredientEditorState';
import type { IngredientWorkspaceView } from './workspaceModel';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let latest: ReturnType<typeof useIngredientEditorState> | null = null;

function makeIngredient(overrides: Partial<Ingredient> & Pick<Ingredient, 'id' | 'name'>): Ingredient {
  return {
    family_id: 'family-1',
    category: '蛋奶',
    default_unit: '个',
    unit_conversions: [],
    quantity_tracking_mode: 'track_quantity',
    default_storage: '冷藏',
    default_expiry_mode: 'none',
    default_expiry_days: null,
    default_low_stock_threshold: null,
    notes: '',
    image: null,
    row_version: 1,
    created_at: '2026-07-01T00:00:00.000Z',
    updated_at: '2026-07-01T00:00:00.000Z',
    ...overrides,
  };
}

type HarnessProps = {
  ingredient: Ingredient;
  transition: (ingredientId: string, payload: IngredientTrackingModeTransitionRequest) => Promise<Ingredient>;
  update: (
    ingredientId: string,
    payload: {
      name: string;
      category: string;
      default_unit: string;
      quantity_tracking_mode?: Ingredient['quantity_tracking_mode'];
      unit_conversions: Ingredient['unit_conversions'];
      default_storage: string;
      default_expiry_mode: Ingredient['default_expiry_mode'];
      default_expiry_days?: number | null;
      default_low_stock_threshold?: number | null;
      notes: string;
      media_ids: string[];
    }
  ) => Promise<Ingredient>;
  onSettled?: (ingredient: Ingredient) => void | Promise<void>;
  notices: Array<{ tone: string; title: string; message: string }>;
  transient: { current: Ingredient | null };
  onReady: (value: ReturnType<typeof useIngredientEditorState>) => void;
};

function HookHost(props: HarnessProps) {
  const [editingIngredientId, setEditingIngredientId] = useState<string | null>(props.ingredient.id);
  const [ingredientForm, setIngredientForm] = useState<IngredientCreateFormState>(() => ({
    ...defaultIngredientForm(),
    name: '鸡蛋改名',
    category: props.ingredient.category,
    defaultUnit: props.ingredient.default_unit,
    quantityTrackingMode: 'not_track_quantity',
    defaultStorage: props.ingredient.default_storage,
    defaultExpiryMode: props.ingredient.default_expiry_mode,
    notes: 'updated notes',
  }));
  const [workspaceView, setWorkspaceView] = useState<IngredientWorkspaceView>('create');
  const [selectedIngredientId, setSelectedIngredientId] = useState<string | null>(props.ingredient.id);
  const [transientIngredient, setTransientIngredient] = useState<Ingredient | null>(null);
  const [inventoryForm, setInventoryForm] = useState<InventoryDrawerFormState>({
    ingredientId: '',
    ingredientQuery: '',
    ingredientLocked: false,
    quantity: '1',
    unit: '个',
    status: 'fresh',
    statusDirty: false,
    purchaseDate: '2026-07-12',
    purchaseDatePreset: 'today',
    expiryInputMode: 'none',
    expiryDays: '',
    expiryDate: '',
    storageLocation: '冷藏',
    notes: '',
  });
  const [inventoryAdvancedOpen, setInventoryAdvancedOpen] = useState(false);
  const [overlayMode, setOverlayMode] = useState<'inventory' | 'shopping' | 'consume' | 'inventoryAction' | null>(
    null
  );

  useEffect(() => {
    props.transient.current = transientIngredient;
  }, [props.transient, transientIngredient]);

  const ingredientOptions = (() => {
    if (!transientIngredient) {
      return [props.ingredient];
    }
    return [transientIngredient, ...[props.ingredient].filter((item) => item.id !== transientIngredient.id)];
  })();

  const state = useIngredientEditorState({
    editingIngredientId,
    setEditingIngredientId,
    ingredientForm,
    setIngredientForm,
    ingredientOptions,
    inventoryItems: [],
    inventoryStates: [],
    setTransientIngredient,
    setSelectedIngredientId,
    setWorkspaceView,
    setInventoryForm,
    setInventoryAdvancedOpen,
    setOverlayMode,
    createIngredient: async () => props.ingredient,
    updateIngredient: props.update,
    transitionIngredientTrackingMode: props.transition,
    onTrackingTransitionSettled: props.onSettled,
    showNotice: (notice) => {
      props.notices.push(notice);
    },
    resolveErrorMessage: (reason, fallback) =>
      reason instanceof Error ? reason.message : fallback,
  });

  useEffect(() => {
    props.onReady(state);
  });

  return (
    <div data-workspace={workspaceView} data-selected={selectedIngredientId ?? ''} data-overlay={overlayMode ?? ''}>
      {ingredientForm.name}
    </div>
  );
}

function renderEditorHarness(props: Omit<HarnessProps, 'onReady'>) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(
      <HookHost
        {...props}
        onReady={(value) => {
          latest = value;
        }}
      />
    );
  });
  return latest!;
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  latest = null;
});

describe('useIngredientEditorState dual-write recovery', () => {
  it('recovers from transition success + profile failure without re-running transition', async () => {
    const ingredient = makeIngredient({ id: 'ingredient-egg', name: '鸡蛋' });
    const transitioned = makeIngredient({
      id: 'ingredient-egg',
      name: '鸡蛋',
      quantity_tracking_mode: 'not_track_quantity',
      row_version: 2,
    });
    const transition = vi.fn(async () => transitioned);
    const update = vi.fn(async () => {
      throw new Error('profile save failed');
    });
    const settled = vi.fn(async () => undefined);
    const notices: Array<{ tone: string; title: string; message: string }> = [];
    const transient = { current: null as Ingredient | null };

    const state = renderEditorHarness({
      ingredient,
      transition,
      update,
      onSettled: settled,
      notices,
      transient,
    });

    await act(async () => {
      await state.submitIngredient(false);
    });
    expect(latest!.trackingTransitionDraft).not.toBeNull();
    expect(latest!.trackingTransitionDraft?.targetMode).toBe('not_track_quantity');

    await act(async () => {
      await latest!.confirmTrackingTransition();
    });

    expect(transition).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledTimes(1);
    expect(settled).toHaveBeenCalledTimes(1);
    expect(latest!.trackingTransitionDraft).toBeNull();
    expect(latest!.trackingTransitionError).toBeNull();
    expect(latest!.ingredientForm.quantityTrackingMode).toBe('not_track_quantity');
    expect(latest!.ingredientForm.name).toBe('鸡蛋改名');
    expect(transient.current?.row_version).toBe(2);
    expect(notices.some((item) => item.title === '数量记录方式已切换，资料未全部保存')).toBe(true);

    // Retry via normal save must be profile-only (no second transition).
    await act(async () => {
      await latest!.submitIngredient(false);
    });
    expect(latest!.trackingTransitionDraft).toBeNull();
    expect(transition).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledTimes(2);
  });
});
