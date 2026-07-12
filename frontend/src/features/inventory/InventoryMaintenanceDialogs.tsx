import type { ComponentProps } from 'react';
import { InventoryOperationHistoryDialog } from './InventoryOperationHistoryDialog';
import { InventoryReconciliationDialog } from './InventoryReconciliationDialog';
import { ShoppingIntakeDialog } from './ShoppingIntakeDialog';

/**
 * Single composition shell for inventory maintenance overlays.
 * Task 9: shopping intake; Task 13: reconciliation; Task 16: operation history.
 */
export type InventoryMaintenanceDialogsProps = {
  shoppingIntake: ComponentProps<typeof ShoppingIntakeDialog> | null;
  reconciliation: ComponentProps<typeof InventoryReconciliationDialog> | null;
  operationHistory: ComponentProps<typeof InventoryOperationHistoryDialog> | null;
};

export function InventoryMaintenanceDialogs(props: InventoryMaintenanceDialogsProps) {
  return (
    <>
      {props.shoppingIntake ? <ShoppingIntakeDialog {...props.shoppingIntake} /> : null}
      {props.reconciliation ? <InventoryReconciliationDialog {...props.reconciliation} /> : null}
      {props.operationHistory ? <InventoryOperationHistoryDialog {...props.operationHistory} /> : null}
    </>
  );
}
