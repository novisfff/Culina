import { isApiError } from '../api/request';

/** Prefer structured API detail messages over the stringified error payload. */
export function messageFromApiError(reason: unknown, fallback: string): string {
  if (isApiError(reason)) {
    const payload = reason.payload;
    if (payload && typeof payload === 'object' && 'detail' in payload) {
      const detail = (payload as { detail?: unknown }).detail;
      if (detail && typeof detail === 'object' && !Array.isArray(detail)) {
        const message = (detail as { message?: unknown }).message;
        if (typeof message === 'string' && message.trim()) return message;
      }
      if (typeof detail === 'string' && detail.trim()) return detail;
    }
    return reason.detail && reason.detail !== '[object Object]' ? reason.detail : fallback;
  }
  return reason instanceof Error && reason.message ? reason.message : fallback;
}

export function queryErrorMessage(error: unknown, fallback: string): string | null {
  return error ? messageFromApiError(error, fallback) : null;
}
