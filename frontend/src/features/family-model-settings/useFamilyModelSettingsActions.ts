import { useCallback, useRef, useState } from 'react';
import type { QueryClient } from '@tanstack/react-query';
import { useQueryClient } from '@tanstack/react-query';
import { familyModelSettingsApi } from '../../api/familyModelSettingsApi';
import {
  invalidateAfterFamilyModelSettingsChanged,
  invalidateAfterFamilySearchReplacementChanged,
} from '../../api/cacheInvalidation';
import type {
  CreateFamilyModelSearchReplacementPayload,
  FamilyModelCapability,
  FamilyModelConfigDraft,
  FamilyModelProviderConnectionCheckPayload,
  FamilyModelProviderProfileCreate,
  FamilyModelProviderProfilePatch,
  FamilyModelSearchReplacementBasePayload,
  FamilyModelSearchReplacementMutationPayload,
  FamilyModelSettings,
} from '../../api/types/modelUsage';
import {
  toSaveDraftPayload,
  type FamilyModelSettingsDraft,
  safeFamilyModelSettingsError,
} from './familyModelSettingsModel';
import type { FamilyModelSettingsBusyAction } from './useFamilyModelSettingsState';

type CreateSearchInput = Omit<CreateFamilyModelSearchReplacementPayload, 'idempotency_key'>;

export interface UseFamilyModelSettingsActionsArgs {
  familyId: string;
  settings: FamilyModelSettings | null;
  draft: FamilyModelConfigDraft | null;
  queryClient?: QueryClient;
  onBusy?: (action: FamilyModelSettingsBusyAction) => void;
  onSettled?: () => void;
}

function idempotencyKey(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `family-model-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function structurallyEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left)
      && Array.isArray(right)
      && left.length === right.length
      && left.every((value, index) => structurallyEqual(value, right[index]));
  }
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false;
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord).sort();
  const rightKeys = Object.keys(rightRecord).sort();
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key, index) => (
      key === rightKeys[index] && structurallyEqual(leftRecord[key], rightRecord[key])
    ));
}

/**
 * Keeps one retry key for structurally equal in-memory input. Real forms build
 * a fresh payload object on every submit, so object identity alone cannot
 * recover a completed receipt after a response is lost. Successful requests
 * clear the entry immediately, including any write-only values it references.
 */
function useInputIdempotencyKeys() {
  const entries = useRef(new Map<string, { input: object; key: string }>());
  const keyFor = useCallback((operation: string, input: object): string => {
    const existing = entries.current.get(operation);
    if (existing && structurallyEqual(existing.input, input)) return existing.key;
    const next = idempotencyKey();
    entries.current.set(operation, { input, key: next });
    return next;
  }, []);
  const clearKey = useCallback((operation: string, key: string) => {
    if (entries.current.get(operation)?.key === key) entries.current.delete(operation);
  }, []);
  return { keyFor, clearKey };
}

export function useFamilyModelSettingsActions(args: UseFamilyModelSettingsActionsArgs) {
  const contextQueryClient = useQueryClient();
  const queryClient = args.queryClient ?? contextQueryClient;
  const [busyAction, setBusyAction] = useState<FamilyModelSettingsBusyAction | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const pending = useRef(false);
  const { keyFor, clearKey } = useInputIdempotencyKeys();

  const idempotentRequest = useCallback(async <T,>(
    operation: string,
    input: object,
    request: (key: string) => Promise<T>,
  ): Promise<T> => {
    const key = keyFor(operation, input);
    const result = await request(key);
    clearKey(operation, key);
    return result;
  }, [clearKey, keyFor]);

  const requireContext = useCallback(() => {
    if (!args.familyId || !args.settings || !args.draft) {
      throw new Error('家庭模型设置还没有加载完成，请稍后再试。');
    }
    return { familyId: args.familyId, settings: args.settings, draft: args.draft };
  }, [args.draft, args.familyId, args.settings]);

  const run = useCallback(async <T,>(
    action: FamilyModelSettingsBusyAction,
    operation: () => Promise<T>,
  ): Promise<T> => {
    if (pending.current) throw new Error('操作正在进行，请稍候。');
    pending.current = true;
    setBusyAction(action);
    setErrorMessage(null);
    args.onBusy?.(action);
    try {
      return await operation();
    } catch (reason) {
      setErrorMessage(safeFamilyModelSettingsError(reason));
      throw reason;
    } finally {
      pending.current = false;
      setBusyAction(null);
      args.onSettled?.();
    }
  }, [args]);

  const invalidateSettings = useCallback(async () => {
    if (!args.familyId) return;
    await invalidateAfterFamilyModelSettingsChanged(queryClient, args.familyId);
  }, [args.familyId, queryClient]);

  const refreshSettingsInBackground = useCallback(() => {
    void invalidateSettings().catch(() => undefined);
  }, [invalidateSettings]);

  const invalidateSearch = useCallback(async () => {
    if (!args.familyId) return;
    await invalidateAfterFamilySearchReplacementChanged(queryClient, args.familyId);
  }, [args.familyId, queryClient]);

  const refreshSearchInBackground = useCallback(() => {
    void invalidateSearch().catch(() => undefined);
  }, [invalidateSearch]);

  const saveDraft = useCallback(async (
    draft: FamilyModelSettingsDraft,
    options: { confirmInitialSearchIndex?: boolean } = {},
  ) => {
    requireContext();
    return run('save', async () => {
      const input = { draft, confirmInitialSearchIndex: Boolean(options.confirmInitialSearchIndex) };
      const result = await idempotentRequest('save-draft', input, (key) => (
        familyModelSettingsApi.saveDraft(toSaveDraftPayload(draft, key, options))
      ));
      refreshSettingsInBackground();
      return result;
    });
  }, [idempotentRequest, refreshSettingsInBackground, requireContext, run]);

  const validateDraft = useCallback(async (baseDraftVersionNumber?: number) => {
    const context = requireContext();
    return run('validate', () => familyModelSettingsApi.validateDraft({
      base_draft_version_number: baseDraftVersionNumber ?? context.draft.draft_version_number,
    }));
  }, [requireContext, run]);

  const createProviderProfile = useCallback(async (input: FamilyModelProviderProfileCreate) => {
    requireContext();
    return run('save', async () => {
      const result = await idempotentRequest('create-provider', input, (key) => familyModelSettingsApi.createProviderProfile({
        ...input,
        idempotency_key: key,
      }));
      refreshSettingsInBackground();
      return result;
    });
  }, [idempotentRequest, refreshSettingsInBackground, requireContext, run]);

  const patchProviderProfile = useCallback(async (profileId: string, input: FamilyModelProviderProfilePatch) => {
    requireContext();
    return run('save', async () => {
      const operation = `patch-provider:${profileId}`;
      const result = await idempotentRequest(operation, input, (key) => familyModelSettingsApi.patchProviderProfile(profileId, {
        ...input,
        idempotency_key: key,
      }));
      refreshSettingsInBackground();
      return result;
    });
  }, [idempotentRequest, refreshSettingsInBackground, requireContext, run]);

  const rotateProviderProfileKey = useCallback(async (
    profileId: string,
    input: Omit<Parameters<typeof familyModelSettingsApi.rotateProviderProfileKey>[1], 'idempotency_key'>,
  ) => {
    requireContext();
    return run('rotate', async () => {
      const operation = `rotate-provider:${profileId}`;
      const result = await idempotentRequest(operation, input, (key) => familyModelSettingsApi.rotateProviderProfileKey(profileId, {
        ...input,
        idempotency_key: key,
      }));
      refreshSettingsInBackground();
      return result;
    });
  }, [idempotentRequest, refreshSettingsInBackground, requireContext, run]);

  const checkProviderConnection = useCallback(async (
    profileId: string,
    input: FamilyModelProviderConnectionCheckPayload = { idempotency_key: '' },
  ) => {
    requireContext();
    const operation = `check-provider:${profileId}`;
    return run('test', () => idempotentRequest(operation, input, (key) => (
      familyModelSettingsApi.checkProviderConnection(profileId, { ...input, idempotency_key: key })
    )));
  }, [idempotentRequest, requireContext, run]);

  const testCapability = useCallback(async (
    capability: FamilyModelCapability,
    variantKey: string,
    confirmBillable: boolean,
    baseDraftVersionNumber: number,
  ) => {
    requireContext();
    if (!confirmBillable) throw new Error('请先确认这会产生真实模型费用。');
    const input = { capability, variantKey, confirmBillable, baseDraftVersionNumber };
    return run('test', async () => {
      const operation = `test-capability:${capability}:${variantKey}`;
      const result = await idempotentRequest(operation, input, (key) => familyModelSettingsApi.testCapability(capability, {
        variant_key: variantKey,
        confirm_billable: true,
        base_draft_version_number: baseDraftVersionNumber,
        idempotency_key: key,
      }));
      refreshSettingsInBackground();
      return result;
    });
  }, [idempotentRequest, refreshSettingsInBackground, requireContext, run]);

  const previewSearchReplacement = useCallback(async (input: FamilyModelSearchReplacementBasePayload) => {
    requireContext();
    return familyModelSettingsApi.previewSearchReplacement(input);
  }, [requireContext]);

  const createSearchReplacement = useCallback(async (input: CreateSearchInput) => {
    requireContext();
    return run('rebuild', async () => {
      const result = await idempotentRequest('create-search-replacement', input, (key) => familyModelSettingsApi.createSearchReplacement({
        ...input,
        idempotency_key: key,
      }));
      refreshSearchInBackground();
      return result;
    });
  }, [idempotentRequest, refreshSearchInBackground, requireContext, run]);

  const retrySearchReplacement = useCallback(async (
    profileId: string,
    input: Omit<FamilyModelSearchReplacementMutationPayload, 'idempotency_key'>,
  ) => {
    requireContext();
    return run('rebuild', async () => {
      const operation = `retry-search-replacement:${profileId}`;
      const result = await idempotentRequest(operation, input, (key) => familyModelSettingsApi.retrySearchReplacement(profileId, {
        ...input,
        idempotency_key: key,
      }));
      refreshSearchInBackground();
      return result;
    });
  }, [idempotentRequest, refreshSearchInBackground, requireContext, run]);

  const cancelSearchReplacement = useCallback(async (
    profileId: string,
    input: Omit<FamilyModelSearchReplacementMutationPayload, 'idempotency_key'>,
  ) => {
    requireContext();
    return run('rebuild', async () => {
      const operation = `cancel-search-replacement:${profileId}`;
      const result = await idempotentRequest(operation, input, (key) => familyModelSettingsApi.cancelSearchReplacement(profileId, {
        ...input,
        idempotency_key: key,
      }));
      refreshSearchInBackground();
      return result;
    });
  }, [idempotentRequest, refreshSearchInBackground, requireContext, run]);

  return {
    busyAction,
    errorMessage,
    actions: {
      saveDraft,
      validateDraft,
      createProviderProfile,
      patchProviderProfile,
      rotateProviderProfileKey,
      checkProviderConnection,
      testCapability,
      previewSearchReplacement,
      createSearchReplacement,
      retrySearchReplacement,
      cancelSearchReplacement,
    },
  };
}
