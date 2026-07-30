import { useCallback, useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api/client';
import { invalidateAfterModelUsagePolicyChanged } from '../../api/cacheInvalidation';
import { queryKeys } from '../../api/queryKeys';
import type { UpdateModelUsagePolicyPayload, UserRole } from '../../api/types';
import {
  buildModelUsagePolicyPayload,
  createModelUsagePolicyDraft,
  policyConflictFromApiError,
  type ModelUsagePolicyDraft,
} from './modelUsageModel';

export interface UseModelUsagePolicyArgs {
  familyId: string;
  role: UserRole;
}

type PolicySaveVariables = {
  familyId: string;
  payload: UpdateModelUsagePolicyPayload;
};

export function useModelUsagePolicy(args: UseModelUsagePolicyArgs) {
  const queryClient = useQueryClient();
  const isOwner = args.role === 'Owner';
  const [draft, setDraft] = useState<ModelUsagePolicyDraft | null>(null);
  const [conflict, setConflict] = useState<ReturnType<typeof policyConflictFromApiError>>(null);
  const initializedFamilyIdRef = useRef<string | null>(null);
  const activeFamilyIdRef = useRef(args.familyId);
  const savingFamilyIdsRef = useRef(new Set<string>());
  activeFamilyIdRef.current = args.familyId;
  const enabled = Boolean(args.familyId) && isOwner;
  const policyQuery = useQuery({
    queryKey: queryKeys.modelUsagePolicy(args.familyId),
    queryFn: api.getFamilyModelUsagePolicy,
    enabled,
  });

  useEffect(() => {
    if (initializedFamilyIdRef.current === args.familyId) return;
    initializedFamilyIdRef.current = null;
    setDraft(null);
    setConflict(null);
  }, [args.familyId]);

  useEffect(() => {
    if (!isOwner || !policyQuery.data || initializedFamilyIdRef.current === args.familyId) return;
    initializedFamilyIdRef.current = args.familyId;
    setDraft(createModelUsagePolicyDraft(policyQuery.data));
    setConflict(null);
  }, [args.familyId, isOwner, policyQuery.data]);

  const mutation = useMutation({
    mutationFn: ({ payload }: PolicySaveVariables) => api.updateFamilyModelUsagePolicy(payload),
    onSuccess: async (savedPolicy, variables) => {
      if (activeFamilyIdRef.current === variables.familyId) {
        setDraft(createModelUsagePolicyDraft(savedPolicy));
        setConflict(null);
      }
      await invalidateAfterModelUsagePolicyChanged(queryClient, variables.familyId);
    },
    onError: (reason, variables) => {
      if (activeFamilyIdRef.current === variables.familyId) {
        setConflict(policyConflictFromApiError(reason));
      }
    },
  });

  const patchDraft = useCallback((patch: Partial<ModelUsagePolicyDraft>) => {
    setDraft((current) => current ? { ...current, ...patch } : current);
  }, []);

  const save = useCallback(async () => {
    const familyId = args.familyId;
    if (!enabled || !draft || savingFamilyIdsRef.current.has(familyId)) return null;
    savingFamilyIdsRef.current.add(familyId);
    try {
      return await mutation.mutateAsync({
        familyId,
        payload: buildModelUsagePolicyPayload(draft),
      });
    } finally {
      savingFamilyIdsRef.current.delete(familyId);
    }
  }, [args.familyId, draft, enabled, mutation]);

  const reviewConflict = useCallback(async () => {
    await policyQuery.refetch();
  }, [policyQuery]);

  const reapplyRetainedDraft = useCallback(() => {
    if (!conflict) return;
    setDraft((current) => current ? {
      ...current,
      base_version_number: conflict.current_version_number,
    } : current);
  }, [conflict]);

  return {
    isOwner,
    policy: policyQuery.data ?? null,
    policyQuery,
    draft,
    conflict,
    isSaving: mutation.isPending && savingFamilyIdsRef.current.has(args.familyId),
    saveError: mutation.error,
    actions: {
      patchDraft,
      save,
      reviewConflict,
      reapplyRetainedDraft,
    },
  };
}
