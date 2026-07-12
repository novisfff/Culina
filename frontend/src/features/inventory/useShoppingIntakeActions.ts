import { useCallback, useRef } from 'react';
import { ApiError, isApiError } from '../../api/request';
import type { ShoppingIntakeRequest, ShoppingIntakeResult } from '../../api/types';
import {
  buildShoppingIntakePayload,
  getSelectedDraftItems,
  rebaseShoppingIntakeDraft,
  renewShoppingIntakeRequestId,
  type ShoppingIntakeDraft,
  type ShoppingIntakeFieldError,
  type ShoppingIntakeSources,
} from './shoppingIntakeModel';
import type { UseShoppingIntakeStateResult } from './useShoppingIntakeState';

export type ShoppingIntakeNotice = {
  tone: 'success' | 'warning' | 'danger';
  title: string;
  message: string;
};

export type UseShoppingIntakeActionsArgs = {
  state: UseShoppingIntakeStateResult;
  submitShoppingIntake: (payload: ShoppingIntakeRequest) => Promise<ShoppingIntakeResult>;
  invalidateAfterInventoryOperation: () => Promise<void>;
  showNotice?: (notice: ShoppingIntakeNotice) => void;
  /** Fetch canonical sources after 409 so every concurrency token can be re-bound. */
  refreshSources?: () => Promise<ShoppingIntakeSources>;
};

export type ShoppingIntakeActions = {
  submitDraft: () => Promise<void>;
  retryLatest: () => Promise<void>;
};

type StructuredDetail = {
  code?: string;
  message?: string;
  field_errors?: Array<{
    shopping_item_id?: string;
    path?: string;
    field?: string;
    message?: string;
    code?: string;
  }>;
  conflicts?: Array<{
    entity_type?: string;
    entity_id?: string;
    message?: string;
    code?: string;
    reason?: string;
  }>;
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
  return null;
}

/** Normalize API snake_case field names to draft camelCase keys used by the dialog. */
function normalizeFieldKey(field: string): string {
  return field.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());
}

/**
 * Map structured 422 field_errors onto draft rows.
 * Paths like `items.0.actual_quantity` resolve index → selected payload order shoppingItemId.
 */
export function mapFieldErrors(
  detail: StructuredDetail | null,
  draft: ShoppingIntakeDraft | null,
): ShoppingIntakeFieldError[] {
  if (!detail?.field_errors?.length) {
    return [];
  }
  const selected = draft ? getSelectedDraftItems(draft) : [];
  return detail.field_errors.map((entry) => {
    const path = entry.path ?? entry.field ?? '';
    const parts = path.split(/[.[\]]+/).filter(Boolean);
    // paths like items.0.actual_quantity or items[0].actual_quantity
    const indexMatch = path.match(/items(?:\.|\[)(\d+)/);
    const index = indexMatch ? Number(indexMatch[1]) : -1;
    const shoppingItemId =
      entry.shopping_item_id ??
      (index >= 0 && index < selected.length ? selected[index].shoppingItemId : '');
    const rawField = parts[parts.length - 1] || entry.field || 'unknown';
    // Drop the bare index token if it was the last part (shouldn't happen with field present).
    const fieldToken = /^\d+$/.test(rawField) ? entry.field || 'unknown' : rawField;
    return {
      shoppingItemId,
      field: normalizeFieldKey(fieldToken),
      code: entry.code ?? detail.code ?? 'invalid_request',
      message: entry.message ?? detail.message ?? '请检查输入',
    };
  });
}

function conflictCodeOf(detail: StructuredDetail | null): UseShoppingIntakeStateResult['conflictState'] {
  const code = detail?.code;
  if (code === 'idempotency_key_reused') {
    return 'idempotency_key_reused';
  }
  if (code === 'stale_version' || code === 'tracking_mode_changed' || code === 'scope_changed') {
    return 'stale_version';
  }
  return 'stale_version';
}

function conflictShoppingItemId(
  conflict: NonNullable<StructuredDetail['conflicts']>[number],
  draft: ShoppingIntakeDraft,
): string {
  const entityId = conflict.entity_id ?? '';
  if (!entityId) return '';
  const direct = draft.items.find((item) => item.shoppingItemId === entityId);
  if (direct) return direct.shoppingItemId;
  const target = draft.items.find((item) => {
    if (item.kind === 'free_text') return false;
    if (conflict.entity_type === 'ingredient') {
      return (
        (item.kind === 'exact_ingredient' || item.kind === 'presence_ingredient') &&
        item.targetId === entityId
      );
    }
    if (conflict.entity_type === 'food') {
      return item.kind === 'food' && item.targetId === entityId;
    }
    if (conflict.entity_type === 'ingredient_inventory_state') {
      return item.kind === 'presence_ingredient' && item.stateId === entityId;
    }
    return false;
  });
  return target?.shoppingItemId ?? '';
}

export function mapShoppingIntakeConflicts(
  detail: StructuredDetail | null,
  draft: ShoppingIntakeDraft,
): ShoppingIntakeFieldError[] {
  if (!detail?.conflicts?.length) return [];
  const byShoppingItem = new Map<string, ShoppingIntakeFieldError>();
  for (const conflict of detail.conflicts) {
    const shoppingItemId = conflictShoppingItemId(conflict, draft);
    if (!shoppingItemId || byShoppingItem.has(shoppingItemId)) continue;
    byShoppingItem.set(shoppingItemId, {
      shoppingItemId,
      field: 'conflict',
      code: conflict.code ?? detail.code ?? 'stale_version',
      message:
        conflict.message ??
        detail.message ??
        '这项采购或库存已被家人更新，请核对最新内容。',
    });
  }
  return [...byShoppingItem.values()];
}

export function useShoppingIntakeActions(args: UseShoppingIntakeActionsArgs): ShoppingIntakeActions {
  const { state, submitShoppingIntake, invalidateAfterInventoryOperation, showNotice, refreshSources } = args;
  const inFlightRef = useRef(false);
  const stateRef = useRef(state);
  stateRef.current = state;
  const submitRef = useRef(submitShoppingIntake);
  submitRef.current = submitShoppingIntake;
  const invalidateRef = useRef(invalidateAfterInventoryOperation);
  invalidateRef.current = invalidateAfterInventoryOperation;
  const showNoticeRef = useRef(showNotice);
  showNoticeRef.current = showNotice;
  const refreshSourcesRef = useRef(refreshSources);
  refreshSourcesRef.current = refreshSources;

  const runSubmit = useCallback(async () => {
    if (inFlightRef.current || stateRef.current.busy) {
      return;
    }
    const currentState = stateRef.current;
    if (!currentState.draft) {
      currentState.setErrorMessage('没有可提交的采购草稿。');
      return;
    }

    const localErrors = currentState.applyLocalValidation();
    if (localErrors.length > 0) {
      return;
    }

    let payload: ShoppingIntakeRequest;
    try {
      payload = buildShoppingIntakePayload(stateRef.current.draft!);
    } catch (reason) {
      stateRef.current.setErrorMessage(messageOf(reason, '请检查采购项后再提交。'));
      return;
    }

    inFlightRef.current = true;
    stateRef.current.setBusy(true);
    stateRef.current.setErrorMessage(null);
    stateRef.current.setConflictState('none');
    stateRef.current.setFieldErrors([]);

    let writeSucceeded = false;
    let result: ShoppingIntakeResult | null = null;

    try {
      result = await submitRef.current(payload);
      writeSucceeded = true;
    } catch (reason) {
      if (isApiError(reason) && reason.status === 422) {
        const detail = extractStructuredDetail(reason);
        const fieldErrors = mapFieldErrors(detail, stateRef.current.draft);
        stateRef.current.setFieldErrors(fieldErrors);
        if (fieldErrors.length > 0) {
          const first = fieldErrors[0];
          stateRef.current.setFocusFieldKey(
            first.shoppingItemId ? `${first.shoppingItemId}:${first.field}` : first.field,
          );
          stateRef.current.setErrorMessage(
            fieldErrors.length === 1
              ? first.message
              : `还有 ${fieldErrors.length} 处需要确认后才能入库。`,
          );
        } else {
          stateRef.current.setErrorMessage(messageOf(reason, '提交内容无效，请检查后重试。'));
        }
        // Keep dialog/draft open on 422.
        return;
      }

      if (isApiError(reason) && reason.status === 409) {
        const detail = extractStructuredDetail(reason);
        const conflictState = conflictCodeOf(detail);
        stateRef.current.setConflictState(conflictState);
        stateRef.current.setErrorMessage(
          detail?.message ||
            messageOf(reason, '家人可能刚改动了采购项或库存，请刷新后重新确认。'),
        );
        let conflictDraft = stateRef.current.draft;
        if (conflictState === 'idempotency_key_reused' && conflictDraft) {
          conflictDraft = renewShoppingIntakeRequestId(conflictDraft);
          stateRef.current.replaceDraft(conflictDraft);
        }
        if (refreshSourcesRef.current) {
          try {
            const latestSources = await refreshSourcesRef.current();
            const currentDraft = conflictDraft ?? stateRef.current.draft;
            if (currentDraft) {
              const rebasedDraft = rebaseShoppingIntakeDraft(currentDraft, latestSources);
              const conflictErrors = mapShoppingIntakeConflicts(detail, rebasedDraft);
              stateRef.current.replaceDraft(rebasedDraft);
              stateRef.current.setFieldErrors(conflictErrors);
              const firstConflict = conflictErrors[0];
              stateRef.current.setFocusFieldKey(
                firstConflict
                  ? `${firstConflict.shoppingItemId}:${firstConflict.field}`
                  : null,
              );
            }
          } catch {
            // Keep current draft; conflict message already set.
          }
        }
        stateRef.current.setStep('review');
        // Keep dialog/draft open; the next submit is an explicit confirmation of rebased data.
        return;
      }

      stateRef.current.setErrorMessage(messageOf(reason, '登记本次购买失败，请稍后重试。'));
      return;
    } finally {
      if (!writeSucceeded) {
        stateRef.current.setBusy(false);
        inFlightRef.current = false;
      }
    }

    // Success path: await invalidation/refetch before moving to result.
    try {
      await invalidateRef.current();
      stateRef.current.setResult(result);
      stateRef.current.setStep('result');
      stateRef.current.setConflictState('none');
      stateRef.current.setFieldErrors([]);
      stateRef.current.setErrorMessage(null);
      showNoticeRef.current?.({
        tone: 'success',
        title: result?.summary.title || '本次购买已登记',
        message: result?.summary.description || '库存与采购项已同步更新。',
      });
    } catch (reason) {
      // Write already succeeded — still show result, warn about refresh.
      stateRef.current.setResult(result);
      stateRef.current.setStep('result');
      showNoticeRef.current?.({
        tone: 'warning',
        title: '购买已登记，但数据刷新失败',
        message: messageOf(reason, '请下拉刷新后再继续。'),
      });
    } finally {
      stateRef.current.setBusy(false);
      inFlightRef.current = false;
    }
  }, []);

  const submitDraft = useCallback(async () => {
    await runSubmit();
  }, [runSubmit]);

  const retryLatest = useCallback(async () => {
    // Network/stale-version retries reuse the request id; key reuse gets renewed in the 409 branch.
    await runSubmit();
  }, [runSubmit]);

  return {
    submitDraft,
    retryLatest,
  };
}

export function isShoppingIntakeApiError(reason: unknown): reason is ApiError {
  return isApiError(reason);
}
