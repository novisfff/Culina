import { createRouteEntryLoader } from './routeEntryLoader';
export const loadFamilySettings = createRouteEntryLoader(
  'family',
  () => import('../../features/family/family-route.css'),
  () => import('../../features/family/FamilySettings').then((module) => ({ default: module.FamilySettings })),
);
