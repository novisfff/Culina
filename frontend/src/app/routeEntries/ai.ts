import { createRouteEntryLoader } from './routeEntryLoader';
export const loadAiWorkspace = createRouteEntryLoader(
  'ai',
  () => Promise.all([import('../../styles/05-workspace-overlays.css'), import('../../components/ai/ai-route.css')]),
  () => import('../../components/ai/AiWorkspace').then((module) => ({ default: module.AiWorkspace })),
);
