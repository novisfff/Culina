import { createRouteEntryLoader } from './routeEntryLoader';
export const loadFamilySettings = createRouteEntryLoader(
  'family',
  () => Promise.all([import('../../styles/route-overlays').then((module) => module.loadRouteOverlayStyles()), import('../../features/family/family-route.css')]),
  () => import('../../features/family/FamilySettings').then((module) => ({ default: module.FamilySettings })),
);
