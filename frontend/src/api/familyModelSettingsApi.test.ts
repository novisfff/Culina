import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockRequest = vi.fn();

vi.mock('./request', () => ({
  request: (...args: unknown[]) => mockRequest(...args),
}));

import { api } from './client';
import { familyModelSettingsApi } from './familyModelSettingsApi';

const NOW = '2026-08-18T10:00:00Z';

const profileCreate = {
  display_name: '家用模型',
  adapter_kind: 'openai_compatible_http' as const,
  auth_mode: 'api_key' as const,
  api_base_url: 'https://provider.example/v1',
  api_key: 'write-only-value',
  idempotency_key: 'profile-create-1',
};

const rate = {
  capability: 'embedding' as const,
  variant_key: 'search',
  meter: 'embedding_tokens' as const,
  unit_quantity: '1000',
  unit_price: '0.02',
  source_currency: 'USD',
  fx_to_cny: '7.2',
  reported_model_aliases: [],
};

describe('familyModelSettingsApi transport', () => {
  beforeEach(() => {
    mockRequest.mockReset();
  });

  it('sends a provider key only in the create request and never models it in a response', async () => {
    mockRequest.mockResolvedValue({
      id: 'profile-1',
      display_name: '家用模型',
      credential: { configured: true, version_number: 1, updated_at: NOW },
    });

    const result = await familyModelSettingsApi.createProviderProfile(profileCreate);

    expect(mockRequest).toHaveBeenCalledWith('/api/family/model-settings/provider-profiles', {
      method: 'POST',
      body: expect.any(String),
    });
    expect(JSON.parse(mockRequest.mock.calls.at(-1)?.[1]?.body).api_key).toBe('write-only-value');
    expect(JSON.stringify(result)).not.toContain('write-only-value');
    expect('api_key' in result).toBe(false);
  });

  it('loads settings, draft and prices from the owner-only route family', async () => {
    mockRequest.mockResolvedValue({});

    await familyModelSettingsApi.getSettings();
    expect(mockRequest).toHaveBeenLastCalledWith('/api/family/model-settings');
    await familyModelSettingsApi.getDraft();
    expect(mockRequest).toHaveBeenLastCalledWith('/api/family/model-settings/draft');
    await familyModelSettingsApi.getPrices();
    expect(mockRequest).toHaveBeenLastCalledWith('/api/family/model-settings/prices');
  });

  it('uses encoded profile and replacement paths for all mutations', async () => {
    mockRequest.mockResolvedValue({});
    const profileId = 'profile / one';
    const replacementId = 'search / one';

    await familyModelSettingsApi.patchProviderProfile(profileId, {
      display_name: '已改名',
      base_profile_version_number: 1,
      idempotency_key: 'profile-patch-1',
    });
    expect(mockRequest).toHaveBeenLastCalledWith('/api/family/model-settings/provider-profiles/profile%20%2F%20one', {
      method: 'PATCH',
      body: JSON.stringify({
        display_name: '已改名',
        base_profile_version_number: 1,
        idempotency_key: 'profile-patch-1',
      }),
    });

    await familyModelSettingsApi.rotateProviderProfileKey(profileId, {
      current_password: 'owner-password',
      new_api_key: 'new-write-only-key',
      base_settings_version_number: 2,
      idempotency_key: 'rotate-key-1',
    });
    expect(mockRequest).toHaveBeenLastCalledWith('/api/family/model-settings/provider-profiles/profile%20%2F%20one/rotate-key', {
      method: 'POST',
      body: expect.any(String),
    });

    await familyModelSettingsApi.checkProviderConnection(profileId, { idempotency_key: 'check-key-1' });
    expect(mockRequest).toHaveBeenLastCalledWith('/api/family/model-settings/provider-profiles/profile%20%2F%20one/connection-check', {
      method: 'POST',
      body: JSON.stringify({ idempotency_key: 'check-key-1' }),
    });

    await familyModelSettingsApi.getSearchReplacement(replacementId);
    expect(mockRequest).toHaveBeenLastCalledWith('/api/family/model-settings/search/replacements/search%20%2F%20one');
    await familyModelSettingsApi.retrySearchReplacement(replacementId, {
      base_settings_version_number: 2,
      idempotency_key: 'retry-key-1',
    });
    expect(mockRequest).toHaveBeenLastCalledWith('/api/family/model-settings/search/replacements/search%20%2F%20one/retry', {
      method: 'POST',
      body: JSON.stringify({ base_settings_version_number: 2, idempotency_key: 'retry-key-1' }),
    });
    await familyModelSettingsApi.cancelSearchReplacement(replacementId, {
      base_settings_version_number: 2,
      idempotency_key: 'cancel-key-1',
    });
    expect(mockRequest).toHaveBeenLastCalledWith('/api/family/model-settings/search/replacements/search%20%2F%20one/cancel', {
      method: 'POST',
      body: JSON.stringify({ base_settings_version_number: 2, idempotency_key: 'cancel-key-1' }),
    });
  });

  it('saves, validates and publishes draft and price data without family or actor fields', async () => {
    mockRequest.mockResolvedValue({});
    const draft = {
      base_config_revision_id: null,
      search_profile_id: null,
      bindings: [],
      price_rates: [rate],
      price_draft: null,
      change_note: '首次配置',
      base_draft_version_number: 0,
      idempotency_key: 'draft-save-1',
    };
    await familyModelSettingsApi.saveDraft(draft);
    expect(mockRequest).toHaveBeenLastCalledWith('/api/family/model-settings/draft', {
      method: 'PUT',
      body: JSON.stringify(draft),
    });
    await familyModelSettingsApi.validateDraft({ base_draft_version_number: 1 });
    expect(mockRequest).toHaveBeenLastCalledWith('/api/family/model-settings/draft/validate', {
      method: 'POST',
      body: JSON.stringify({ base_draft_version_number: 1 }),
    });
    await familyModelSettingsApi.publish({
      base_settings_version_number: 2,
      base_draft_version_number: 1,
      idempotency_key: 'publish-key-1',
      config_checksum: 'a'.repeat(64),
      price_checksum: 'b'.repeat(64),
      current_password: 'owner-password',
    });
    expect(mockRequest).toHaveBeenLastCalledWith('/api/family/model-settings/publish', {
      method: 'POST',
      body: expect.any(String),
    });

    await familyModelSettingsApi.savePricesDraft({
      base_price_version_id: 'price-1',
      rates: [rate],
      change_note: '调价',
      base_draft_version_number: 0,
      idempotency_key: 'price-draft-1',
    });
    expect(mockRequest).toHaveBeenLastCalledWith('/api/family/model-settings/prices/draft', {
      method: 'PUT',
      body: expect.any(String),
    });
    await familyModelSettingsApi.publishPrices({
      base_settings_version_number: 2,
      base_price_version_id: 'price-1',
      idempotency_key: 'price-publish-1',
      confirm_checksum: 'c'.repeat(64),
      change_note: '调价',
      rates: [rate],
    });
    expect(mockRequest).toHaveBeenLastCalledWith('/api/family/model-settings/prices/publish', {
      method: 'POST',
      body: expect.any(String),
    });
  });

  it('supports explicitly billable capability tests and search replacement lifecycle', async () => {
    mockRequest.mockResolvedValue({});
    await familyModelSettingsApi.testCapability('llm', {
      variant_key: 'primary',
      confirm_billable: true,
      idempotency_key: 'test-key-1',
    });
    expect(mockRequest).toHaveBeenLastCalledWith('/api/family/model-settings/capabilities/llm/test', {
      method: 'POST',
      body: JSON.stringify({ variant_key: 'primary', confirm_billable: true, idempotency_key: 'test-key-1' }),
    });

    const replacement = {
      base_settings_version_number: 2,
      base_search_profile_id: 'search-1',
      provider_profile_id: 'profile-1',
      requested_model: 'text-embedding-3-small',
      dimensions: 1536,
      rates: [rate],
    };
    await familyModelSettingsApi.previewSearchReplacement(replacement);
    expect(mockRequest).toHaveBeenLastCalledWith('/api/family/model-settings/search/replacements/preview', {
      method: 'POST',
      body: JSON.stringify(replacement),
    });
    await familyModelSettingsApi.createSearchReplacement({
      ...replacement,
      confirm_checksum: 'd'.repeat(64),
      current_password: 'owner-password',
      idempotency_key: 'replacement-create-1',
    });
    expect(mockRequest).toHaveBeenLastCalledWith('/api/family/model-settings/search/replacements', {
      method: 'POST',
      body: expect.any(String),
    });
  });

  it('is exposed through the central API client', async () => {
    mockRequest.mockResolvedValue({});
    await api.getFamilyModelSettings();
    expect(mockRequest).toHaveBeenCalledWith('/api/family/model-settings');
  });
});
