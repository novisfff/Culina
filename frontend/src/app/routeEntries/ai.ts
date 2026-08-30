import { createRouteEntryLoader } from './routeEntryLoader';
export const loadAiWorkspace = createRouteEntryLoader(
  'ai',
  () => Promise.all([import('../../styles/route-overlays').then((module) => module.loadRouteOverlayStyles()), import('../../components/ai/ai-route.css')]),
  () => import('../../components/ai/AiWorkspace').then((module) => ({ default: module.AiWorkspace })),
);
