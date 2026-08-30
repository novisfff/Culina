import { createRouteEntryLoader } from './routeEntryLoader';
export const loadModelUsageWorkspace = createRouteEntryLoader(
  'model-usage',
  () => Promise.all([import('../../styles/05-workspace-overlays.css'), import('../../features/model-usage/model-usage-route.css')]),
  () => import('../../features/model-usage/ModelUsageWorkspace').then((module) => ({ default: module.ModelUsageWorkspace })),
);
export const loadModelUsageRequestLogs = createRouteEntryLoader(
  'model-usage',
  () => Promise.all([import('../../styles/05-workspace-overlays.css'), import('../../features/model-usage/model-usage-route.css')]),
  () => import('../../features/model-usage/ModelUsageRequestLogsPage').then((module) => ({ default: module.ModelUsageRequestLogsPage })),
);
export const loadFamilyModelSettings = createRouteEntryLoader(
  'family-model-settings',
  () => Promise.all([import('../../styles/05-workspace-overlays.css'), import('../../features/family-model-settings/family-model-settings-route.css')]),
  () => import('../../features/family-model-settings/FamilyModelSettingsWorkspace').then((module) => ({ default: module.FamilyModelSettingsWorkspace })),
);
