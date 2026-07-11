import type { ComponentProps } from 'react';
import { ShoppingIntakeDialog } from './ShoppingIntakeDialog';

/**
 * Single composition shell for inventory maintenance overlays.
 * Task 9 starts with ShoppingIntakeDialog only; Tasks 13 and 16 extend this shell
 * with reconciliation and operation history.
 */
export type InventoryMaintenanceDialogsProps = {
  shoppingIntake: ComponentProps<typeof ShoppingIntakeDialog> | null;
};

export function InventoryMaintenanceDialogs(props: InventoryMaintenanceDialogsProps) {
  if (!props.shoppingIntake) {
    return null;
  }
  return <ShoppingIntakeDialog {...props.shoppingIntake} />;
}
