import { createRouteEntryLoader } from './routeEntryLoader';
export const loadAiWorkspace = createRouteEntryLoader(
  'ai',
  () => import('../../components/ai/ai-route.css'),
  () => import('../../components/ai/AiWorkspace').then((module) => ({ default: module.AiWorkspace })),
);
