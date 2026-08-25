import { useCallback, useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { aiApi } from '../../api/aiApi';
import { isApiError } from '../../api/client';
import { queryKeys } from '../../api/queryKeys';
import type { AiAutoExecutionActionKey, AiAutoExecutionSettingRow } from '../../api/types';

type Scope = 'member' | 'family';
type UpdatePayload = { enabled: boolean; expected_row_version: number; consent_notice_version?: string };
export type AiAutoExecutionRowFailure = { scope: Scope; actionKey: AiAutoExecutionActionKey; payload: UpdatePayload; message: string; isConflict: boolean };

function operationId(scope: Scope, key: AiAutoExecutionActionKey) {
  return `${scope}:${key}`;
}

export function useAiAutoExecutionSettings(familyId: string) {
  const queryClient = useQueryClient();
  const [pending, setPending] = useState<Record<string, true>>({});
  const [failures, setFailures] = useState<Record<string, AiAutoExecutionRowFailure>>({});
  const familyRef = useRef(familyId);
  const pendingRef = useRef(new Set<string>());
  const queryKey = queryKeys.aiAutoExecutionSettings(familyId);
  const query = useQuery({
    queryKey,
    queryFn: aiApi.getAiAutoExecutionSettings,
    enabled: Boolean(familyId),
    placeholderData: undefined,
  });

  useEffect(() => {
    if (familyRef.current === familyId) return;
    familyRef.current = familyId;
    setPending({});
    pendingRef.current.clear();
    setFailures({});
  }, [familyId]);

  const update = useCallback(async (scope: Scope, row: AiAutoExecutionSettingRow, enabled: boolean, retryPayload?: UpdatePayload) => {
    if (!familyId) return;
    const key = queryKeys.aiAutoExecutionSettings(familyId);
    const id = operationId(scope, row.action_key);
    if (pending[id]) return;
    const payload = retryPayload ?? {
      enabled,
      expected_row_version: row.row_version,
      ...(enabled ? { consent_notice_version: query.data?.consent_notice.version } : {}),
    };
    pendingRef.current.add(id);
    setPending((current) => ({ ...current, [id]: true }));
    setFailures((current) => { const { [id]: _removed, ...rest } = current; return rest; });
    try {
      const result = scope === 'member'
        ? await aiApi.updateAiAutoExecutionPreference(row.action_key, payload)
        : await aiApi.updateAiAutoExecutionFamilyPolicy(row.action_key, payload);
      void result;
    } catch (error) {
      if (familyRef.current === familyId) {
        if (isApiError(error) && error.status === 409) {
          setFailures((current) => ({ ...current, [id]: { scope, actionKey: row.action_key, payload, message: '设置已在其他页面更新，请重新确认', isConflict: true } }));
          await queryClient.refetchQueries({ queryKey: key, type: 'active' });
        } else {
          setFailures((current) => ({ ...current, [id]: { scope, actionKey: row.action_key, payload, message: '设置保存失败，请重试。', isConflict: false } }));
        }
      }
    } finally {
      pendingRef.current.delete(id);
      if (familyRef.current === familyId) setPending((current) => {
        const { [id]: _resolved, ...rest } = current;
        return rest;
      });
      if (familyRef.current === familyId && pendingRef.current.size === 0) {
        await queryClient.refetchQueries({ queryKey: key, type: 'active' });
      }
    }
  }, [familyId, pending, query.data?.consent_notice.version, queryClient]);

  return {
    settings: query.data ?? null,
    isLoading: query.isLoading,
    isError: query.isError,
    failureFor: (scope: Scope, key: AiAutoExecutionActionKey) => failures[operationId(scope, key)] ?? null,
    isPending: (scope: Scope, key: AiAutoExecutionActionKey) => Boolean(pending[operationId(scope, key)]),
    retry: () => void query.refetch(),
    update,
  };
}
