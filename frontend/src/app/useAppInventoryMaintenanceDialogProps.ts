import type { AppInventoryMaintenanceDialogsProps } from './AppInventoryMaintenanceDialogs';
import type { InventoryOperationResult } from '../api/types';
import type { useShoppingIntakeController } from '../features/inventory/useShoppingIntakeController';
import type { useReconciliationController } from '../features/inventory/useReconciliationController';
import type { useAppInventoryOperationHistory } from './useAppInventoryOperations';

type InventoryOperationsQuery = {
  isLoading: boolean;
  isFetching: boolean;
  data?: unknown;
  error: unknown;
  refetch: () => unknown;
};

type Args = {
  shoppingIntakeState: ReturnType<typeof useShoppingIntakeController>;
  reconciliationController: ReturnType<typeof useReconciliationController>;
  operationHistory: ReturnType<typeof useAppInventoryOperationHistory>;
  inventoryOperations: NonNullable<AppInventoryMaintenanceDialogsProps['operationHistory']>['operations'];
  inventoryOperationsQuery: InventoryOperationsQuery;
  referenceDate: string;
  familyId: string;
  userId: string;
  isRevertPending: boolean;
  setRecentBannerOverride: (result: InventoryOperationResult | null) => void;
  handleRevertInventoryOperation: (operationId: string) => void | Promise<void>;
  openOperationHistory: (operationId?: string) => void;
  closeOperationHistory: () => void;
  loadOperationDetail: (operationId: string) => void | Promise<void>;
};

/** Owns the cross-domain prop adapter for inventory maintenance overlays. */
export function useAppInventoryMaintenanceDialogProps(args: Args): AppInventoryMaintenanceDialogsProps {
  const shopping = args.shoppingIntakeState;
  const reconciliation = args.reconciliationController;
  const reconciliationState = reconciliation.state;
  const reconciliationActions = reconciliation.actions;
  const history = args.operationHistory;

  return {
    shoppingIntake: shopping.open
      ? {
          open: shopping.open,
          step: shopping.step,
          draft: shopping.draft,
          busy: shopping.busy || args.isRevertPending,
          errorMessage: shopping.errorMessage,
          fieldErrors: shopping.fieldErrors,
          focusFieldKey: shopping.focusFieldKey,
          conflictState: shopping.conflictState,
          result: shopping.result,
          expandedExceptionIds: shopping.expandedExceptionIds,
          freeTextCandidatesByItemId: shopping.candidatesByItemId,
          freeTextLinkOptions: shopping.linkOptions,
          onClose: () => {
            if (shopping.result) args.setRecentBannerOverride(shopping.result);
            shopping.closeIntake();
          },
          onGoReview: shopping.goToReview,
          onGoSelect: shopping.goToSelect,
          onToggleItem: shopping.toggleItemSelected,
          onPatchItem: shopping.patchItem,
          onCompleteFreeText: shopping.completeFreeText,
          onLinkFreeText: shopping.linkCandidate,
          onToggleException: shopping.toggleExceptionExpanded,
          onSubmit: () => void shopping.submitDraft(),
          onRetry: () => void shopping.retryLatest(),
          onRevertResult: (operationId) => void args.handleRevertInventoryOperation(operationId),
          onViewResult: (operationId) => args.openOperationHistory(operationId),
        }
      : null,
    reconciliation: reconciliationState.open
      ? {
          open: reconciliationState.open,
          step: reconciliationState.step,
          scope: reconciliationState.scope,
          draft: reconciliationState.draft,
          groups: reconciliationState.groups,
          orderedGroups: reconciliationState.orderedGroups,
          referenceDate: args.referenceDate,
          loading: reconciliationState.loading,
          busy: reconciliationState.busy || args.isRevertPending,
          errorMessage: reconciliationState.errorMessage,
          fieldErrors: reconciliationState.fieldErrors,
          focusFieldKey: reconciliationState.focusFieldKey,
          conflictState: reconciliationState.conflictState,
          result: reconciliationState.result,
          summary: reconciliationState.summary,
          checkedCount: reconciliationState.checkedCount,
          totalCount: reconciliationState.totalCount,
          canSubmit: reconciliationState.canSubmit,
          expandedBatchGroupKeys: reconciliationState.expandedBatchGroupKeys,
          onClose: () => {
            if (reconciliationState.result) args.setRecentBannerOverride(reconciliationState.result);
            reconciliationState.closeReconciliation({
              familyId: args.familyId,
              userId: args.userId,
              force: reconciliationState.loading,
            });
          },
          onChangeScope: reconciliation.changeScope,
          onToggleBatchDetails: reconciliationState.toggleBatchDetails,
          onSetIntent: (intent) => reconciliationState.setIntent(intent, new Date().toISOString()),
          onClearIntent: (targetKey) => reconciliationState.clearIntent(targetKey, new Date().toISOString()),
          onGoSummary: reconciliationState.goToSummary,
          onGoReview: reconciliationState.goToReview,
          onSubmit: () => void reconciliationActions.submitDraft(),
          onRetry: () => void reconciliationActions.retryLatest(),
          onRevertResult: (operationId) => void args.handleRevertInventoryOperation(operationId),
          onViewResult: (operationId) => args.openOperationHistory(operationId),
        }
      : null,
    operationHistory: history.open
      ? {
          open: history.open,
          operations: args.inventoryOperations,
          loading: args.inventoryOperationsQuery.isLoading || (args.inventoryOperationsQuery.isFetching && !args.inventoryOperationsQuery.data),
          busy: args.isRevertPending,
          errorMessage: history.error ?? '加载库存变更记录失败',
          selectedOperationId: history.selectedOperationId,
          detail: history.detail,
          detailLoading: history.detailLoading,
          detailError: history.detailError,
          conflictMessage: history.conflict,
          initialOperationId: history.initialOperationId,
          onClose: args.closeOperationHistory,
          onSelectOperation: history.setSelectedOperationId,
          onLoadDetail: (operationId) => void args.loadOperationDetail(operationId),
          onRevert: (operationId) => void args.handleRevertInventoryOperation(operationId),
          onRetry: () => {
            void args.inventoryOperationsQuery.refetch();
            if (history.selectedOperationId) void args.loadOperationDetail(history.selectedOperationId);
          },
        }
      : null,
  };
}
