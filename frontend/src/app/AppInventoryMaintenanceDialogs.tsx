import { lazy, Suspense, type ComponentProps } from 'react';

const InventoryMaintenanceDialogs = lazy(() =>
  import('../features/inventory/InventoryMaintenanceDialogs').then((module) => ({
    default: module.InventoryMaintenanceDialogs,
  })),
);

export type AppInventoryMaintenanceDialogsProps = ComponentProps<typeof InventoryMaintenanceDialogs>;

/** Application composition entry for inventory maintenance overlay bundles. */
export function AppInventoryMaintenanceDialogs(props: AppInventoryMaintenanceDialogsProps) {
  return (
    <Suspense fallback={null}>
      <InventoryMaintenanceDialogs {...props} />
    </Suspense>
  );
}
