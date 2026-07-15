import { isApiError } from '../../api/request';
import type { MealLogCandidate } from '../../api/types';

export function extractMealRecordErrorCode(reason: unknown): string | null {
  if (!isApiError(reason)) return null;
  const payload = reason.payload;
  if (!payload || typeof payload !== 'object' || !('detail' in payload)) return null;
  const detail = (payload as { detail?: unknown }).detail;
  if (detail && typeof detail === 'object' && !Array.isArray(detail) && 'code' in detail) {
    const code = (detail as { code?: unknown }).code;
    return typeof code === 'string' ? code : null;
  }
  return null;
}

export function messageFromMealRecordReason(reason: unknown, fallback: string): string {
  if (isApiError(reason)) {
    const payload = reason.payload;
    if (payload && typeof payload === 'object' && 'detail' in payload) {
      const detail = (payload as { detail?: unknown }).detail;
      if (detail && typeof detail === 'object' && !Array.isArray(detail)) {
        const message = (detail as { message?: unknown }).message;
        if (typeof message === 'string' && message.trim()) {
          return message;
        }
      }
      if (typeof detail === 'string' && detail.trim()) {
        return detail;
      }
    }
    if (reason.detail && reason.detail !== '[object Object]') {
      return reason.detail;
    }
    return fallback;
  }
  if (reason instanceof Error && reason.message.trim()) {
    return reason.message;
  }
  return fallback;
}

export type CompactStaleRecovery = {
  candidates: MealLogCandidate[];
  target: MealLogCandidate extends never ? never : import('../../api/types').RecordMealTarget;
  selectedCandidateId: string | null;
  candidateMode: 'none' | 'single' | 'multi';
  error: string;
};

/**
 * Resolve refreshed candidates after meal_log_stale and produce a reconfirm state patch.
 * Caller supplies the presentation derivation so this stays free of circular imports.
 */
export async function resolveRefetchedCandidates(
  refetch: () => Promise<{ data?: MealLogCandidate[] | undefined } | unknown>,
): Promise<MealLogCandidate[]> {
  const result = await refetch();
  if (result && typeof result === 'object' && 'data' in result) {
    const data = (result as { data?: MealLogCandidate[] | undefined }).data;
    return Array.isArray(data) ? data : [];
  }
  if (Array.isArray(result)) {
    return result as MealLogCandidate[];
  }
  return [];
}
