import type { InventoryOperationResult, InventoryReconciliationGroup } from '../../api/types/inventory';
import type {
  InventoryReconciliationDraft,
  InventoryReconciliationScope,
  InventoryReconciliationStep,
  ReconciliationConflictState,
  ReconciliationFieldError,
  ReconciliationSubmitSummary,
} from './inventoryReconciliationModel';

export type InventoryReconciliationDialogViewModel = Readonly<{
  open: boolean;
  step: InventoryReconciliationStep;
  scope: InventoryReconciliationScope;
  draft: InventoryReconciliationDraft | null;
  groups: readonly InventoryReconciliationGroup[];
  orderedGroups: readonly InventoryReconciliationGroup[];
  referenceDate: string;
  loading: boolean;
  busy: boolean;
  fieldErrors: readonly ReconciliationFieldError[];
  focusFieldKey: string | null;
  conflictState: ReconciliationConflictState;
  hasConflict: boolean;
  result: InventoryOperationResult | null;
  hasResult: boolean;
  summary: ReconciliationSubmitSummary;
}>;

export type InventoryReconciliationDialogViewModelInput = Omit<
  InventoryReconciliationDialogViewModel,
  'conflictState' | 'hasConflict' | 'hasResult' | 'fieldErrors' | 'result'
> & {
  fieldErrors?: ReconciliationFieldError[];
  conflictState?: ReconciliationConflictState;
  result?: InventoryOperationResult | null;
};

export function sortReconciliationFieldErrors(
  errors: readonly ReconciliationFieldError[],
): ReconciliationFieldError[] {
  return [...errors].sort((left, right) =>
    left.targetKey.localeCompare(right.targetKey) || left.field.localeCompare(right.field),
  );
}

export function buildInventoryReconciliationDialogViewModel(
  input: InventoryReconciliationDialogViewModelInput,
): InventoryReconciliationDialogViewModel {
  const fieldErrors = Object.freeze(sortReconciliationFieldErrors(input.fieldErrors ?? []));
  const conflictState = input.conflictState ?? 'none';
  const result = input.result ?? null;
  return Object.freeze({
    ...input,
    groups: input.groups,
    orderedGroups: input.orderedGroups,
    loading: Boolean(input.loading),
    busy: Boolean(input.busy),
    fieldErrors,
    focusFieldKey: input.focusFieldKey ?? null,
    conflictState,
    hasConflict: conflictState !== 'none',
    result,
    hasResult: result !== null,
  });
}
