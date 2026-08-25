import { useCallback, useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { aiApi } from '../../api/aiApi';
import { isApiError } from '../../api/client';
import { queryKeys } from '../../api/queryKeys';
import type { AiAutoExecutionActionKey, AiAutoExecutionSettingRow } from '../../api/types';

type Scope = 'member' | 'family';

export function useAiAutoExecutionSettings(familyId: string) {
  const queryClient = useQueryClient();
  const [pending, setPending] = useState<{ key: AiAutoExecutionActionKey; scope: Scope } | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const familyRef = useRef(familyId);
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
    setPending(null);
    setErrorMessage(null);
  }, [familyId]);

  const update = useCallback(async (scope: Scope, row: AiAutoExecutionSettingRow, enabled: boolean) => {
    if (!familyId || pending) return;
    const key = queryKeys.aiAutoExecutionSettings(familyId);
    setPending({ key: row.action_key, scope });
    setErrorMessage(null);
    try {
      const payload = {
        enabled,
        expected_row_version: row.row_version,
        ...(enabled ? { consent_notice_version: query.data?.consent_notice.version } : {}),
      };
      const result = scope === 'member'
        ? await aiApi.updateAiAutoExecutionPreference(row.action_key, payload)
        : await aiApi.updateAiAutoExecutionFamilyPolicy(row.action_key, payload);
      if (familyRef.current === familyId) queryClient.setQueryData(key, result);
    } catch (error) {
      if (familyRef.current === familyId) {
        if (isApiError(error) && error.status === 409) {
          setErrorMessage('设置已在其他页面更新，请重新确认');
          await queryClient.invalidateQueries({ queryKey: key });
        } else {
          setErrorMessage('设置保存失败，请重试。');
        }
      }
    } finally {
      if (familyRef.current === familyId) setPending(null);
    }
  }, [familyId, pending, query.data?.consent_notice.version, queryClient]);

  return {
    settings: query.data ?? null,
    isLoading: query.isLoading,
    isError: query.isError,
    errorMessage,
    pendingActionKey: pending?.key ?? null,
    pendingScope: pending?.scope ?? null,
    retry: () => void query.refetch(),
    update,
  };
}
