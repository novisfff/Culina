import { useCallback, useMemo, useRef, useState } from 'react';
import type {
  Food,
  Ingredient,
  IngredientInventoryState,
  ShoppingIntakeResult,
  ShoppingListItem,
} from '../../api/types';
import {
  buildShoppingIntakeDraft,
  canAdvanceToReview,
  canSubmitIntake,
  completeFreeTextWithoutInventory,
  linkFreeTextDraft,
  setDraftItemSelected,
  updateDraftItem,
  validateShoppingIntakeDraft,
  type FreeTextLinkTarget,
  type ShoppingIntakeDraft,
  type ShoppingIntakeDraftItem,
  type ShoppingIntakeFieldError,
  type ShoppingIntakeStep,
} from './shoppingIntakeModel';

export type ShoppingIntakeOpenArgs = {
  selectedItemId?: string;
};

export type ShoppingIntakeConflictState = 'none' | 'stale_version' | 'idempotency_key_reused';

export type UseShoppingIntakeStateResult = {
  open: boolean;
  step: ShoppingIntakeStep;
  draft: ShoppingIntakeDraft | null;
  expandedExceptionIds: string[];
  busy: boolean;
  errorMessage: string | null;
  fieldErrors: ShoppingIntakeFieldError[];
  focusFieldKey: string | null;
  conflictState: ShoppingIntakeConflictState;
  result: ShoppingIntakeResult | null;
  selectedCount: number;
  canGoReview: boolean;
  canSubmit: boolean;
  openIntake: (args: {
    shoppingItems: ShoppingListItem[];
    ingredients: Ingredient[];
    foods: Food[];
    inventoryStates?: IngredientInventoryState[];
    referenceDate: string;
    selectedItemId?: string;
    now?: string;
  }) => void;
  closeIntake: () => void;
  setStep: (step: ShoppingIntakeStep) => void;
  goToReview: () => boolean;
  goToSelect: () => void;
  toggleItemSelected: (shoppingItemId: string) => void;
  setItemSelected: (shoppingItemId: string, selected: boolean) => void;
  patchItem: (shoppingItemId: string, patch: Partial<ShoppingIntakeDraftItem>) => void;
  completeFreeText: (shoppingItemId: string) => void;
  linkFreeText: (shoppingItemId: string, target: FreeTextLinkTarget) => void;
  toggleExceptionExpanded: (shoppingItemId: string) => void;
  setBusy: (busy: boolean) => void;
  setErrorMessage: (message: string | null) => void;
  setFieldErrors: (errors: ShoppingIntakeFieldError[]) => void;
  setFocusFieldKey: (key: string | null) => void;
  setConflictState: (state: ShoppingIntakeConflictState) => void;
  setResult: (result: ShoppingIntakeResult | null) => void;
  replaceDraft: (draft: ShoppingIntakeDraft) => void;
  applyLocalValidation: () => ShoppingIntakeFieldError[];
  resetForNewIntake: () => void;
};

const EMPTY_ERRORS: ShoppingIntakeFieldError[] = [];

export function useShoppingIntakeState(): UseShoppingIntakeStateResult {
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<ShoppingIntakeStep>('select');
  const [draft, setDraft] = useState<ShoppingIntakeDraft | null>(null);
  const [expandedExceptionIds, setExpandedExceptionIds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<ShoppingIntakeFieldError[]>(EMPTY_ERRORS);
  const [focusFieldKey, setFocusFieldKey] = useState<string | null>(null);
  const [conflictState, setConflictState] = useState<ShoppingIntakeConflictState>('none');
  const [result, setResult] = useState<ShoppingIntakeResult | null>(null);

  const busyRef = useRef(false);
  busyRef.current = busy;
  const draftRef = useRef<ShoppingIntakeDraft | null>(null);
  draftRef.current = draft;

  const selectedCount = useMemo(
    () => draft?.items.filter((item) => item.selected).length ?? 0,
    [draft],
  );
  const canGoReview = useMemo(() => (draft ? canAdvanceToReview(draft) : false), [draft]);
  const canSubmit = useMemo(() => (draft ? canSubmitIntake(draft) : false), [draft]);

  const openIntake: UseShoppingIntakeStateResult['openIntake'] = useCallback((args) => {
    const nextDraft = buildShoppingIntakeDraft({
      shoppingItems: args.shoppingItems,
      ingredients: args.ingredients,
      foods: args.foods,
      inventoryStates: args.inventoryStates,
      selectedItemId: args.selectedItemId,
      referenceDate: args.referenceDate,
      now: args.now,
    });
    setDraft(nextDraft);
    setStep('select');
    setExpandedExceptionIds([]);
    setBusy(false);
    setErrorMessage(null);
    setFieldErrors(EMPTY_ERRORS);
    setFocusFieldKey(null);
    setConflictState('none');
    setResult(null);
    setOpen(true);
  }, []);

  const closeIntake = useCallback(() => {
    if (busyRef.current) {
      return;
    }
    setOpen(false);
    setStep('select');
    setDraft(null);
    setExpandedExceptionIds([]);
    setErrorMessage(null);
    setFieldErrors(EMPTY_ERRORS);
    setFocusFieldKey(null);
    setConflictState('none');
    setResult(null);
  }, []);

  const goToReview = useCallback(() => {
    const current = draftRef.current;
    if (!current || !canAdvanceToReview(current)) {
      setErrorMessage('请先勾选本次买到的项目。');
      return false;
    }
    setErrorMessage(null);
    setFieldErrors(EMPTY_ERRORS);
    setFocusFieldKey(null);
    setStep('review');
    return true;
  }, []);

  const goToSelect = useCallback(() => {
    if (busyRef.current) return;
    setStep('select');
    setErrorMessage(null);
    setFieldErrors(EMPTY_ERRORS);
    setFocusFieldKey(null);
  }, []);

  const toggleItemSelected = useCallback((shoppingItemId: string) => {
    setDraft((current) => {
      if (!current) return current;
      const item = current.items.find((entry) => entry.shoppingItemId === shoppingItemId);
      if (!item) return current;
      return setDraftItemSelected(current, shoppingItemId, !item.selected);
    });
    setErrorMessage(null);
  }, []);

  const setItemSelected = useCallback((shoppingItemId: string, selected: boolean) => {
    setDraft((current) => (current ? setDraftItemSelected(current, shoppingItemId, selected) : current));
    setErrorMessage(null);
  }, []);

  const patchItem = useCallback((shoppingItemId: string, patch: Partial<ShoppingIntakeDraftItem>) => {
    setDraft((current) => (current ? updateDraftItem(current, shoppingItemId, patch) : current));
    setErrorMessage(null);
    setFieldErrors((current) => current.filter((error) => error.shoppingItemId !== shoppingItemId));
  }, []);

  const completeFreeText = useCallback((shoppingItemId: string) => {
    setDraft((current) => (current ? completeFreeTextWithoutInventory(current, shoppingItemId) : current));
    setErrorMessage(null);
  }, []);

  const linkFreeText = useCallback((shoppingItemId: string, target: FreeTextLinkTarget) => {
    setDraft((current) => {
      if (!current) return current;
      return linkFreeTextDraft(current, shoppingItemId, target, current.purchaseDate);
    });
    setErrorMessage(null);
  }, []);

  const toggleExceptionExpanded = useCallback((shoppingItemId: string) => {
    setExpandedExceptionIds((current) =>
      current.includes(shoppingItemId)
        ? current.filter((id) => id !== shoppingItemId)
        : [...current, shoppingItemId],
    );
  }, []);

  const setFocusFieldKeyAndExpand = useCallback((key: string | null) => {
    setFocusFieldKey(key);
    if (!key) return;
    const shoppingItemId = key.includes(':') ? key.split(':')[0] : '';
    if (!shoppingItemId) return;
    setExpandedExceptionIds((current) =>
      current.includes(shoppingItemId) ? current : [...current, shoppingItemId],
    );
  }, []);

  const applyLocalValidation = useCallback(() => {
    const current = draftRef.current;
    if (!current) {
      const empty: ShoppingIntakeFieldError[] = [
        {
          shoppingItemId: '',
          field: 'items',
          code: 'empty_operation',
          message: '请先勾选本次买到的项目。',
        },
      ];
      setFieldErrors(empty);
      return empty;
    }
    const errors = validateShoppingIntakeDraft(current);
    setFieldErrors(errors);
    if (errors.length > 0) {
      const first = errors[0];
      const focusKey = first.shoppingItemId ? `${first.shoppingItemId}:${first.field}` : first.field;
      setFocusFieldKey(focusKey);
      if (first.shoppingItemId) {
        setExpandedExceptionIds((current) =>
          current.includes(first.shoppingItemId) ? current : [...current, first.shoppingItemId],
        );
      }
      setErrorMessage(
        errors.length === 1 ? first.message : `还有 ${errors.length} 处需要确认后才能入库。`,
      );
    } else {
      setFocusFieldKey(null);
      setErrorMessage(null);
    }
    return errors;
  }, []);

  const resetForNewIntake = useCallback(() => {
    setOpen(false);
    setStep('select');
    setDraft(null);
    setExpandedExceptionIds([]);
    setBusy(false);
    setErrorMessage(null);
    setFieldErrors(EMPTY_ERRORS);
    setFocusFieldKey(null);
    setConflictState('none');
    setResult(null);
  }, []);

  return {
    open,
    step,
    draft,
    expandedExceptionIds,
    busy,
    errorMessage,
    fieldErrors,
    focusFieldKey,
    conflictState,
    result,
    selectedCount,
    canGoReview,
    canSubmit,
    openIntake,
    closeIntake,
    setStep,
    goToReview,
    goToSelect,
    toggleItemSelected,
    setItemSelected,
    patchItem,
    completeFreeText,
    linkFreeText,
    toggleExceptionExpanded,
    setBusy,
    setErrorMessage,
    setFieldErrors,
    setFocusFieldKey: setFocusFieldKeyAndExpand,
    setConflictState,
    setResult,
    replaceDraft: setDraft,
    applyLocalValidation,
    resetForNewIntake,
  };
}
