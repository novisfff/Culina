import { request } from './request';
import type {
  CreateFamilyModelSearchReplacementPayload,
  FamilyModelCapability,
  FamilyModelCapabilityTestPayload,
  FamilyModelCapabilityTestResult,
  FamilyModelConfigDraft,
  FamilyModelDraftValidation,
  FamilyModelPrices,
  FamilyModelProviderConnectionCheckPayload,
  FamilyModelProviderConnectionCheckResult,
  FamilyModelProviderProfile,
  FamilyModelProviderProfileCreate,
  FamilyModelProviderProfileDeletePayload,
  FamilyModelProviderProfileDeletionCheck,
  FamilyModelProviderProfilePatch,
  FamilyModelSearchReplacement,
  FamilyModelSearchReplacementMutationPayload,
  FamilyModelSearchReplacementPreview,
  FamilyModelSearchReplacementPreviewResult,
  FamilyModelSettings,
  RotateFamilyModelProviderProfileKeyPayload,
  RotateFamilyModelProviderProfileKeyResult,
  SaveFamilyModelConfigDraftPayload,
} from './types';

const FAMILY_MODEL_SETTINGS_PREFIX = '/api/family/model-settings';

function profilePath(profileId: string): string {
  return `${FAMILY_MODEL_SETTINGS_PREFIX}/provider-profiles/${encodeURIComponent(profileId)}`;
}

function replacementPath(profileId: string): string {
  return `${FAMILY_MODEL_SETTINGS_PREFIX}/search/replacements/${encodeURIComponent(profileId)}`;
}

function post<T>(path: string, payload: unknown): Promise<T> {
  return request<T>(path, { method: 'POST', body: JSON.stringify(payload) });
}

export const familyModelSettingsApi = {
  getSettings: () => request<FamilyModelSettings>(FAMILY_MODEL_SETTINGS_PREFIX),
  getFamilyModelSettings: () => request<FamilyModelSettings>(FAMILY_MODEL_SETTINGS_PREFIX),
  getDraft: () => request<FamilyModelConfigDraft>(`${FAMILY_MODEL_SETTINGS_PREFIX}/draft`),
  saveDraft: (payload: SaveFamilyModelConfigDraftPayload) =>
    request<FamilyModelConfigDraft>(`${FAMILY_MODEL_SETTINGS_PREFIX}/draft`, {
      method: 'PUT',
      body: JSON.stringify(payload),
    }),
  validateDraft: (payload: { base_draft_version_number: number }) =>
    post<FamilyModelDraftValidation>(`${FAMILY_MODEL_SETTINGS_PREFIX}/draft/validate`, payload),
  getPrices: () => request<FamilyModelPrices>(`${FAMILY_MODEL_SETTINGS_PREFIX}/prices`),
  createProviderProfile: (payload: FamilyModelProviderProfileCreate) =>
    post<FamilyModelProviderProfile>(`${FAMILY_MODEL_SETTINGS_PREFIX}/provider-profiles`, payload),
  patchProviderProfile: (profileId: string, payload: FamilyModelProviderProfilePatch) =>
    request<FamilyModelProviderProfile>(profilePath(profileId), {
      method: 'PATCH',
      body: JSON.stringify(payload),
    }),
  checkProviderProfileDeletion: (profileId: string) =>
    request<FamilyModelProviderProfileDeletionCheck>(`${profilePath(profileId)}/deletion-check`),
  deleteProviderProfile: (profileId: string, payload: FamilyModelProviderProfileDeletePayload) =>
    request<void>(profilePath(profileId), {
      method: 'DELETE',
      body: JSON.stringify(payload),
    }),
  rotateProviderProfileKey: (profileId: string, payload: RotateFamilyModelProviderProfileKeyPayload) =>
    post<RotateFamilyModelProviderProfileKeyResult>(`${profilePath(profileId)}/rotate-key`, payload),
  checkProviderConnection: (profileId: string, payload: FamilyModelProviderConnectionCheckPayload) =>
    post<FamilyModelProviderConnectionCheckResult>(`${profilePath(profileId)}/connection-check`, payload),
  discoverProviderModels: (profileId: string) =>
    request<FamilyModelProviderConnectionCheckResult>(`${profilePath(profileId)}/models`),
  testCapability: (capability: FamilyModelCapability, payload: FamilyModelCapabilityTestPayload) =>
    post<FamilyModelCapabilityTestResult>(
      `${FAMILY_MODEL_SETTINGS_PREFIX}/capabilities/${encodeURIComponent(capability)}/test`,
      payload,
    ),
  previewSearchReplacement: (payload: FamilyModelSearchReplacementPreview) =>
    post<FamilyModelSearchReplacementPreviewResult>(
      `${FAMILY_MODEL_SETTINGS_PREFIX}/search/replacements/preview`,
      payload,
    ),
  createSearchReplacement: (payload: CreateFamilyModelSearchReplacementPayload) =>
    post<FamilyModelSearchReplacement>(`${FAMILY_MODEL_SETTINGS_PREFIX}/search/replacements`, payload),
  getCurrentSearchReplacement: () => request<FamilyModelSearchReplacement | null>(
    `${FAMILY_MODEL_SETTINGS_PREFIX}/search/replacements/current`,
  ),
  getSearchReplacement: (profileId: string) => request<FamilyModelSearchReplacement>(replacementPath(profileId)),
  retrySearchReplacement: (profileId: string, payload: FamilyModelSearchReplacementMutationPayload) =>
    post<FamilyModelSearchReplacement>(`${replacementPath(profileId)}/retry`, payload),
  cancelSearchReplacement: (profileId: string, payload: FamilyModelSearchReplacementMutationPayload) =>
    post<FamilyModelSearchReplacement>(`${replacementPath(profileId)}/cancel`, payload),
};
