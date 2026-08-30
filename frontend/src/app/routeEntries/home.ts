import { createRouteEntryLoader } from './routeEntryLoader';
export const loadHomeDashboard = createRouteEntryLoader(
  'home',
  () => Promise.all([import('../../styles/route-overlays').then((module) => module.loadRouteOverlayStyles()), import('../../features/home/home-route.css')]),
  () => import('../../features/home/HomeDashboard').then((module) => ({ default: module.HomeDashboard })),
);
