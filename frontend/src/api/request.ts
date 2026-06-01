import { readStringStorage, removeStorage, writeStringStorage } from '../lib/storage';

export const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? 'http://127.0.0.1:8010';

const ACCESS_TOKEN_STORAGE_KEY = 'culina-access-token';

let authToken: string | null = readStringStorage(ACCESS_TOKEN_STORAGE_KEY, '') || null;

export class ApiError extends Error {
  status: number;
  detail: string;
  path: string;
  payload: unknown;

  constructor(args: { status: number; detail: string; path: string; payload: unknown }) {
    super(args.detail);
    this.name = 'ApiError';
    this.status = args.status;
    this.detail = args.detail;
    this.path = args.path;
    this.payload = args.payload;
  }
}

export function isApiError(reason: unknown): reason is ApiError {
  return reason instanceof ApiError;
}

export function setAccessToken(token: string | null) {
  authToken = token;
  if (token) {
    writeStringStorage(ACCESS_TOKEN_STORAGE_KEY, token);
  } else {
    removeStorage(ACCESS_TOKEN_STORAGE_KEY);
  }
}

export function getAccessToken() {
  return authToken;
}

function resolveApiErrorDetail(payload: unknown, fallback: string) {
  if (typeof payload === 'string' && payload.trim()) {
    return payload;
  }
  if (payload && typeof payload === 'object' && 'detail' in payload) {
    const detail = (payload as { detail?: unknown }).detail;
    if (typeof detail === 'string' && detail.trim()) {
      return detail;
    }
    if (Array.isArray(detail) && detail.length > 0) {
      return detail
        .map((item) => {
          if (typeof item === 'string') return item;
          if (item && typeof item === 'object' && 'msg' in item) {
            return String((item as { msg: unknown }).msg);
          }
          return String(item);
        })
        .filter(Boolean)
        .join('；');
    }
    if (detail !== undefined && detail !== null) {
      return String(detail);
    }
  }
  return fallback || '请求失败';
}

export async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (!headers.has('Content-Type') && !(init.body instanceof FormData) && init.body !== undefined) {
    headers.set('Content-Type', 'application/json');
  }
  if (authToken) {
    headers.set('Authorization', `Bearer ${authToken}`);
  }

  const response = await fetch(`${API_BASE_URL}${path}`, {
    ...init,
    headers,
  });

  if (response.status === 204) {
    return undefined as T;
  }

  const isJson = response.headers.get('Content-Type')?.includes('application/json');
  const payload = isJson ? await response.json() : await response.text();
  if (!response.ok) {
    if (response.status === 401) {
      setAccessToken(null);
    }
    throw new ApiError({
      status: response.status,
      detail: resolveApiErrorDetail(payload, response.statusText),
      path,
      payload,
    });
  }

  return payload as T;
}
