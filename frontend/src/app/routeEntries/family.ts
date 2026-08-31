import { createRouteEntryLoader } from './routeEntryLoader';
export const loadFamilySettings = createRouteEntryLoader(
  'family',
  () => Promise.all([import('../../styles/05-workspace-overlays.css'), import('../../features/family/family-route.css')]),
  () => import('../../features/family/FamilySettings').then((module) => ({ default: module.FamilySettings })),
);
