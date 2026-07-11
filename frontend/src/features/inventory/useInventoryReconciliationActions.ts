import { useCallback, useRef } from 'react';
import type {
  InventoryOperationResult,
  InventoryReconciliationRequest,
  InventoryReconciliationResponse,
} from '../../api/types';
import { ApiError, isApiError } from '../../api/request';
import {
  buildReconciliationPayload,
  intentTargetKey,
  storageLocationForScope,
  type InventoryReconciliationDraft,
  type InventoryReconciliationScope,
  type ReconciliationConflictState,
  type ReconciliationFieldError,
} from './inventoryReconciliationModel';
import type { UseInventoryReconciliationStateResult } from './useInventoryReconciliationState';

export type InventoryReconciliationNotice = {
  tone: 'success' | 'warning' | 'danger';
  title: string;
  message: string;
};

export type UseInventoryReconciliationActionsArgs = {
  familyId: string;
  userId: string;
  referenceDate: string;
  state: UseInventoryReconciliationStateResult;
  fetchReconciliation: (args: {
    scope: InventoryReconciliationScope;
    storageLocation: string | null;
  }) => Promise<InventoryReconciliationResponse>;
  submitReconciliation: (request: InventoryReconciliationRequest) => Promise<InventoryOperationResult>;
  invalidateAfterInventoryOperation: () => Promise<void>;
  showNotice: (notice: InventoryReconciliationNotice) => void;
  /** Optional clock injection for tests; defaults to device now. */
  now?: () => string;
};

export type InventoryReconciliationActions = {
  openReconciliation: (
    scope: InventoryReconciliationScope,
    storageLocation?: string | null,
  ) => Promise<void>;
  submitDraft: () => Promise<void>;
  retryLatest: () => Promise<void>;
};

type StructuredDetail = {
  code?: string;
  message?: string;
  field_errors?: Array<{ path?: string; field?: string; message?: string; code?: string }>;
  conflicts?: Array<{ entity_type?: string; entity_id?: string; message?: string; code?: string }>;
};

function messageOf(reason: unknown, fallback: string) {
  if (isApiError(reason)) {
    return reason.detail || fallback;
  }
  if (reason instanceof Error && reason.message) {
    return reason.message;
  }
  return fallback;
}

function extractStructuredDetail(reason: unknown): StructuredDetail | null {
  if (!isApiError(reason)) {
    return null;
  }
  const payload = reason.payload;
  if (!payload || typeof payload !== 'object') {
    return null;
  }
  const detail = (payload as { detail?: unknown }).detail;
  if (detail && typeof detail === 'object' && !Array.isArray(detail)) {
    return detail as StructuredDetail;
  }
  // Legacy string detail only — no structured fields.
  return null;
}

function normalizeFieldKey(field: string): string {
  return field.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());
}

function conflictCodeOf(detail: StructuredDetail | null): ReconciliationConflictState {
  const code = detail?.code;
  if (code === 'idempotency_key_reused') return 'idempotency_key_reused';
  if (code === 'scope_changed') return 'scope_changed';
  if (code === 'tracking_mode_changed') return 'tracking_mode_changed';
  if (code === 'missing_target') return 'missing_target';
  if (code === 'stale_version') return 'stale_version';
  return 'stale_version';
}

/**
 * Map structured 422 field_errors onto draft intents by payload group index.
 * Paths like `groups.0.updates.0.actual_remaining_quantity` resolve to targetKey + field.
 */
export function mapReconciliationFieldErrors(
  detail: StructuredDetail | null,
  draft: InventoryReconciliationDraft | null,
): ReconciliationFieldError[] {
  if (!detail?.field_errors?.length) {
    return [];
  }
  const intents = draft?.intents ?? [];
  return detail.field_errors.map((entry) => {
    const path = entry.path ?? entry.field ?? '';
    const indexMatch = path.match(/groups(?:\.|\[)(\d+)/);
    const index = indexMatch ? Number(indexMatch[1]) : -1;
    const intent = index >= 0 && index < intents.length ? intents[index] : null;
    const targetKey = intent ? intentTargetKey(intent) : '';
    const parts = path.split(/[.[\]]+/).filter(Boolean);
    const rawField = parts[parts.length - 1] || entry.field || 'unknown';
    const fieldToken = /^\d+$/.test(rawField) ? entry.field || 'unknown' : rawField;

    // Preserve nested batch field identity when present: batch:<id>:actualRemainingQuantity
    let field = normalizeFieldKey(fieldToken);
    const updateMatch = path.match(/updates(?:\.|\[)(\d+)/);
    if (intent?.kind === 'exact_ingredient' && updateMatch) {
      const updateIndex = Number(updateMatch[1]);
      const update = intent.updates[updateIndex];
      if (update) {
        field = `batch:${update.inventoryItemId}:${field}`;
      }
    }
    const createMatch = path.match(/creates(?:\.|\[)(\d+)/);
    if (intent?.kind === 'exact_ingredient' && createMatch) {
      const createIndex = Number(createMatch[1]);
      const create = intent.creates[createIndex];
      if (create) {
        field = `create:${create.clientLineId}:${field}`;
      }
    }

    return {
      targetKey,
      field,
      code: entry.code ?? detail.code ?? 'invalid_request',
      message: entry.message ?? detail.message ?? '请检查输入',
    };
  });
}

function resolveStorageLocation(
  scope: InventoryReconciliationScope,
  storageLocation?: string | null,
): string | null {
  if (storageLocation !== undefined) {
    return storageLocation;
  }
  return storageLocationForScope(scope);
}

export function useInventoryReconciliationActions(
  args: UseInventoryReconciliationActionsArgs,
): InventoryReconciliationActions {
  const {
    familyId,
    userId,
    referenceDate,
    state,
    fetchReconciliation,
    submitReconciliation,
    invalidateAfterInventoryOperation,
    showNotice,
    now,
  } = args;

  const inFlightRef = useRef(false);
  const stateRef = useRef(state);
  stateRef.current = state;
  const familyIdRef = useRef(familyId);
  familyIdRef.current = familyId;
  const userIdRef = useRef(userId);
  userIdRef.current = userId;
  const referenceDateRef = useRef(referenceDate);
  referenceDateRef.current = referenceDate;
  const fetchRef = useRef(fetchReconciliation);
  fetchRef.current = fetchReconciliation;
  const submitRef = useRef(submitReconciliation);
  submitRef.current = submitReconciliation;
  const invalidateRef = useRef(invalidateAfterInventoryOperation);
  invalidateRef.current = invalidateAfterInventoryOperation;
  const showNoticeRef = useRef(showNotice);
  showNoticeRef.current = showNotice;
  const nowRef = useRef(now);
  nowRef.current = now;

  const currentNow = useCallback(() => {
    return nowRef.current?.() ?? new Date().toISOString();
  }, []);

  const openReconciliation = useCallback(
    async (scope: InventoryReconciliationScope, storageLocation?: string | null) => {
      if (inFlightRef.current || stateRef.current.busy) {
        return;
      }

      const resolvedStorage = resolveStorageLocation(scope, storageLocation);
      const timestamp = currentNow();
      const { restoredDraftPrompt } = stateRef.current.beginOpen({
        familyId: familyIdRef.current,
        userId: userIdRef.current,
        scope,
        storageLocation: resolvedStorage,
        now: timestamp,
      });

      try {
        const response = await fetchRef.current({
          scope,
          storageLocation: resolvedStorage,
        });
        stateRef.current.applyLoadedGroups({
          response,
          scope,
          storageLocation: resolvedStorage,
        });

        if (restoredDraftPrompt) {
          // Replay local draft against the latest projection; never auto-confirm new groups.
          stateRef.current.acceptRestoredDraft({
            draft: restoredDraftPrompt,
            latest: response,
            familyId: familyIdRef.current,
            userId: userIdRef.current,
            referenceDate: referenceDateRef.current,
            now: currentNow(),
          });
        }
      } catch (reason) {
        stateRef.current.setLoading(false);
        stateRef.current.setErrorMessage(messageOf(reason, '加载盘点清单失败，请稍后重试。'));
      }
    },
    [currentNow],
  );

  const runSubmit = useCallback(async () => {
    if (inFlightRef.current || stateRef.current.busy) {
      return;
    }
    const currentState = stateRef.current;
    if (!currentState.draft) {
      currentState.setErrorMessage('没有可提交的盘点草稿。');
      return;
    }

    const localErrors = currentState.applyLocalValidation();
    if (localErrors.length > 0) {
      return;
    }

    let payload: InventoryReconciliationRequest;
    try {
      payload = buildReconciliationPayload(stateRef.current.draft!);
    } catch (reason) {
      stateRef.current.setErrorMessage(messageOf(reason, '请检查盘点内容后再提交。'));
      return;
    }

    inFlightRef.current = true;
    stateRef.current.setBusy(true);
    stateRef.current.setErrorMessage(null);
    stateRef.current.setConflictState('none');
    stateRef.current.setFieldErrors([]);

    let writeSucceeded = false;
    let result: InventoryOperationResult | null = null;

    try {
      result = await submitRef.current(payload);
      writeSucceeded = true;
    } catch (reason) {
      if (isApiError(reason) && reason.status === 422) {
        const detail = extractStructuredDetail(reason);
        const fieldErrors = mapReconciliationFieldErrors(detail, stateRef.current.draft);
        stateRef.current.setFieldErrors(fieldErrors);
        if (fieldErrors.length > 0) {
          const first = fieldErrors[0];
          stateRef.current.setFocusFieldKey(
            first.targetKey ? `${first.targetKey}:${first.field}` : first.field,
          );
          stateRef.current.setErrorMessage(
            fieldErrors.length === 1
              ? first.message
              : `还有 ${fieldErrors.length} 处需要确认后才能提交。`,
          );
        } else {
          stateRef.current.setErrorMessage(messageOf(reason, '提交内容无效，请检查后重试。'));
        }
        return;
      }

      if (isApiError(reason) && reason.status === 409) {
        const detail = extractStructuredDetail(reason);
        stateRef.current.setConflictState(conflictCodeOf(detail));
        stateRef.current.setErrorMessage(
          detail?.message ||
            messageOf(reason, '家人可能刚改动了库存，请刷新后重新确认。'),
        );

        // Refresh latest projection and replay current draft; keep dialog open.
        try {
          const scope = stateRef.current.scope;
          const storageLocation = stateRef.current.storageLocation;
          const latest = await fetchRef.current({ scope, storageLocation });
          const currentDraft = stateRef.current.draft;
          if (currentDraft) {
            stateRef.current.acceptRestoredDraft({
              draft: currentDraft,
              latest,
              familyId: familyIdRef.current,
              userId: userIdRef.current,
              referenceDate: referenceDateRef.current,
              now: currentNow(),
            });
          } else {
            stateRef.current.applyLoadedGroups({
              response: latest,
              scope,
              storageLocation,
            });
          }
        } catch {
          // Keep current draft; conflict message already set.
        }
        return;
      }

      stateRef.current.setErrorMessage(messageOf(reason, '提交盘点失败，请稍后重试。'));
      return;
    } finally {
      if (!writeSucceeded) {
        stateRef.current.setBusy(false);
        inFlightRef.current = false;
      }
    }

    // Success path: await invalidation before result; never optimistically mutate inventory caches.
    try {
      await invalidateRef.current();
      stateRef.current.setResultAndClearDraft({
        result: result!,
        familyId: familyIdRef.current,
        userId: userIdRef.current,
      });
      stateRef.current.setConflictState('none');
      stateRef.current.setFieldErrors([]);
      stateRef.current.setErrorMessage(null);
      showNoticeRef.current?.({
        tone: 'success',
        title: result?.summary.title || '本次盘点已完成',
        message: result?.summary.description || '库存确认已同步更新。',
      });
    } catch (reason) {
      stateRef.current.setResultAndClearDraft({
        result: result!,
        familyId: familyIdRef.current,
        userId: userIdRef.current,
      });
      showNoticeRef.current?.({
        tone: 'warning',
        title: '盘点已完成，但数据刷新失败',
        message: messageOf(reason, '请下拉刷新后再继续。'),
      });
    } finally {
      stateRef.current.setBusy(false);
      inFlightRef.current = false;
    }
  }, [currentNow]);

  const submitDraft = useCallback(async () => {
    await runSubmit();
  }, [runSubmit]);

  const retryLatest = useCallback(async () => {
    // Network/conflict retry reuses the same draft clientRequestId.
    await runSubmit();
  }, [runSubmit]);

  return {
    openReconciliation,
    submitDraft,
    retryLatest,
  };
}

export function isInventoryReconciliationApiError(reason: unknown): reason is ApiError {
  return isApiError(reason);
}
