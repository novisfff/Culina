import { removeStorage } from '../lib/storage';
import {
  publishAuthCookieTransition,
  subscribeAuthCookieTransition,
  withAuthCookieLock,
} from './authSessionCoordinator';
import type { LoginResponse } from './types';

export const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? '';

const ACCESS_TOKEN_STORAGE_KEY = 'culina-access-token';

let authToken: string | null = null;
let refreshPromise: Promise<LoginResponse> | null = null;
let authSessionRevision = 0;
let authIdentity: string | null = null;
let authIdentityEpoch = 0;
const authSessionListeners = new Set<(payload: LoginResponse | null) => void>();
const authorizedResponseIdentityEpochs = new WeakMap<Response, number>();

type AuthRequestBehavior = {
  authCookieLockHeld?: boolean;
};

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
  if (token === null && authIdentity !== null) {
    authSessionRevision += 1;
    authIdentityEpoch += 1;
    authIdentity = null;
  }
}

export function getAccessToken() {
  return authToken;
}

export function purgeLegacyAccessToken() {
  removeStorage(ACCESS_TOKEN_STORAGE_KEY);
}

export function subscribeAuthSession(listener: (payload: LoginResponse | null) => void) {
  authSessionListeners.add(listener);
  return () => {
    authSessionListeners.delete(listener);
  };
}

export function setAuthenticatedSession(payload: LoginResponse) {
  const nextIdentity = `${payload.user.id}:${payload.membership.family_id}`;
  authSessionRevision += 1;
  if (authIdentity !== nextIdentity) {
    authIdentityEpoch += 1;
  }
  authToken = payload.access_token;
  authIdentity = nextIdentity;
  authSessionListeners.forEach((listener) => listener(payload));
}

export function clearAuthenticatedSession() {
  authSessionRevision += 1;
  if (authIdentity !== null) {
    authIdentityEpoch += 1;
  }
  authToken = null;
  authIdentity = null;
  authSessionListeners.forEach((listener) => listener(null));
}

purgeLegacyAccessToken();

function resolveApiErrorDetail(payload: unknown, fallback: string) {
  if (typeof payload === 'string' && payload.trim()) {
    return payload;
  }
  if (payload && typeof payload === 'object' && 'detail' in payload) {
    const detail = (payload as { detail?: unknown }).detail;
    if (typeof detail === 'string' && detail.trim()) {
      return detail;
    }
    if (detail && typeof detail === 'object' && !Array.isArray(detail) && 'message' in detail) {
      const message = (detail as { message?: unknown }).message;
      if (typeof message === 'string' && message.trim()) {
        return message;
      }
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

async function responsePayload(response: Response): Promise<unknown> {
  const isJson = response.headers.get('Content-Type')?.includes('application/json');
  return isJson ? response.json() : response.text();
}

function apiUrl(path: string) {
  if (/^https?:\/\//.test(path)) return path;
  return `${API_BASE_URL}${path}`;
}

function canRefreshAfterUnauthorized(path: string) {
  return ![
    '/api/auth/login',
    '/api/auth/refresh',
    '/api/auth/logout',
  ].some((authPath) => path.endsWith(authPath));
}

export async function refreshAuthSession(
  behavior: AuthRequestBehavior = {},
): Promise<LoginResponse> {
  const startRefresh = () => {
    const requestedRevision = authSessionRevision;
    const refreshOperation = async () => {
      if (authSessionRevision !== requestedRevision) {
        throw new Error('认证状态已更新，已忽略过期的刷新请求');
      }
      const response = await fetch(apiUrl('/api/auth/refresh'), {
        method: 'POST',
        credentials: 'include',
      });
      const payload = await responsePayload(response);
      if (!response.ok) {
        throw new ApiError({
          status: response.status,
          detail: resolveApiErrorDetail(payload, response.statusText),
          path: '/api/auth/refresh',
          payload,
        });
      }
      if (authSessionRevision !== requestedRevision) {
        throw new Error('认证状态已更新，已忽略过期的刷新响应');
      }
      const authenticated = payload as LoginResponse;
      setAuthenticatedSession(authenticated);
      publishAuthCookieTransition(authenticated);
      return authenticated;
    };
    return (
      behavior.authCookieLockHeld
        ? refreshOperation()
        : withAuthCookieLock(refreshOperation)
    )
      .catch((reason) => {
        if (authSessionRevision === requestedRevision) {
          clearAuthenticatedSession();
          if (reason instanceof ApiError && reason.status === 401) {
            publishAuthCookieTransition(null);
          }
        }
        throw reason;
      });
  };

  if (behavior.authCookieLockHeld) {
    return startRefresh();
  }
  if (!refreshPromise) {
    refreshPromise = startRefresh().finally(() => {
      refreshPromise = null;
    });
  }
  return refreshPromise;
}

async function fetchWithAccessToken(
  path: string,
  init: RequestInit,
  accessToken: string | null,
): Promise<Response> {
  const headers = new Headers(init.headers);
  if (!headers.has('Content-Type') && !(init.body instanceof FormData) && init.body !== undefined) {
    headers.set('Content-Type', 'application/json');
  }
  if (accessToken) {
    headers.set('Authorization', `Bearer ${accessToken}`);
  }

  return fetch(apiUrl(path), {
    ...init,
    headers,
    credentials: 'include',
  });
}

function assertResponseIdentity(
  identityUsed: string | null,
  identityEpochUsed: number,
): void {
  if (identityEpochUsed !== authIdentityEpoch || authIdentity !== identityUsed) {
    throw new Error('认证身份已切换，已忽略旧会话响应');
  }
}

export function assertAuthorizedResponseIdentity(response: Response): void {
  const responseIdentityEpoch = authorizedResponseIdentityEpochs.get(response);
  if (responseIdentityEpoch !== undefined && responseIdentityEpoch !== authIdentityEpoch) {
    throw new Error('认证身份已切换，已忽略旧会话响应');
  }
}

export async function authorizedFetch(
  path: string,
  init: RequestInit = {},
  behavior: AuthRequestBehavior = {},
): Promise<Response> {
  let tokenUsed = authToken;
  let identityUsed = authIdentity;
  let identityEpochUsed = authIdentityEpoch;
  let response = await fetchWithAccessToken(path, init, tokenUsed);
  assertResponseIdentity(identityUsed, identityEpochUsed);
  if (response.status === 401 && tokenUsed && canRefreshAfterUnauthorized(path)) {
    if (authToken === tokenUsed) {
      await refreshAuthSession(behavior);
    }
    tokenUsed = authToken;
    identityUsed = authIdentity;
    identityEpochUsed = authIdentityEpoch;
    if (tokenUsed) {
      response = await fetchWithAccessToken(path, init, tokenUsed);
      assertResponseIdentity(identityUsed, identityEpochUsed);
    }
  }
  if (
    response.status === 401
    && tokenUsed
    && authToken === tokenUsed
    && !path.endsWith('/api/auth/login')
  ) {
    clearAuthenticatedSession();
    identityEpochUsed = authIdentityEpoch;
  }
  authorizedResponseIdentityEpochs.set(response, identityEpochUsed);
  return response;
}

export async function request<T>(
  path: string,
  init: RequestInit = {},
  behavior: AuthRequestBehavior = {},
): Promise<T> {
  const response = await authorizedFetch(path, init, behavior);

  if (response.status === 204) {
    assertAuthorizedResponseIdentity(response);
    return undefined as T;
  }

  const payload = await responsePayload(response);
  assertAuthorizedResponseIdentity(response);
  if (!response.ok) {
    throw new ApiError({
      status: response.status,
      detail: resolveApiErrorDetail(payload, response.statusText),
      path,
      payload,
    });
  }

  return payload as T;
}

subscribeAuthCookieTransition((payload) => {
  if (payload) {
    setAuthenticatedSession(payload);
    return;
  }
  clearAuthenticatedSession();
});
