import { createRouteEntryLoader } from './routeEntryLoader';
export const loadHomeDashboard = createRouteEntryLoader(
  'home',
  () => import('../../features/home/home-route.css'),
  () => import('../../features/home/HomeDashboard').then((module) => ({ default: module.HomeDashboard })),
);
