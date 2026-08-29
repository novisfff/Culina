import { lazy, Suspense, type ComponentProps } from 'react';

const InventoryMaintenanceDialogs = lazy(() =>
  import('./routeEntries/inventory').then((module) => module.loadInventoryMaintenanceDialogs()),
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
