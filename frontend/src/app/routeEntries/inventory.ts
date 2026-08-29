import { createRouteEntryLoader } from './routeEntryLoader';
export const loadInventoryMaintenanceDialogs = createRouteEntryLoader(
  'inventory-maintenance',
  () => import('../../features/inventory/inventory-route.css'),
  () => import('../../features/inventory/InventoryMaintenanceDialogs').then((module) => ({ default: module.InventoryMaintenanceDialogs })),
);
