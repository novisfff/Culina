import { createRouteEntryLoader } from './routeEntryLoader';
export const loadInventoryMaintenanceDialogs = createRouteEntryLoader(
  'inventory-maintenance',
  () => Promise.all([import('../../styles/05-workspace-overlays.css'), import('../../features/inventory/inventory-route.css')]),
  () => import('../../features/inventory/InventoryMaintenanceDialogs').then((module) => ({ default: module.InventoryMaintenanceDialogs })),
);
