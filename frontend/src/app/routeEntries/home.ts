import { createRouteEntryLoader } from './routeEntryLoader';
export const loadHomeDashboard = createRouteEntryLoader(
  'home',
  () => Promise.all([import('../../styles/05-workspace-overlays.css'), import('../../features/home/home-route.css')]),
  () => import('../../features/home/HomeDashboard').then((module) => ({ default: module.HomeDashboard })),
);
