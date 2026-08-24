import {
  clearAuthenticatedSession,
  refreshAuthSession,
  request,
  setAuthenticatedSession,
} from './request';
import {
  publishAuthCookieTransition,
  withAuthCookieLock,
} from './authSessionCoordinator';
import type { AuthSnapshot, LoginResponse } from './types';

export const authApi = {
  login: (username: string, password: string) => withAuthCookieLock(async () => {
    const payload = await request<LoginResponse>(
      '/api/auth/login',
      {
        method: 'POST',
        body: JSON.stringify({ username, password }),
      },
      { authCookieLockHeld: true },
    );
    setAuthenticatedSession(payload);
    publishAuthCookieTransition(payload);
    return payload;
  }),
  refresh: () => refreshAuthSession(),
  me: () => request<AuthSnapshot>('/api/auth/me'),
  logout: () => withAuthCookieLock(async () => {
    await request<void>(
      '/api/auth/logout',
      { method: 'POST' },
      { authCookieLockHeld: true },
    );
    clearAuthenticatedSession();
    publishAuthCookieTransition(null);
  }),
  updateMe: (payload: { display_name: string; email?: string | null; phone?: string | null; avatar_seed?: string | null; avatar_media_id?: string | null; pending_image_job_id?: string | null }) =>
    request<LoginResponse['user']>('/api/auth/me', {
      method: 'PATCH',
      body: JSON.stringify(payload),
    }),
  updatePassword: (payload: { current_password: string; new_password: string }) => (
    withAuthCookieLock(async () => {
      await request<void>(
        '/api/auth/password',
        {
          method: 'PATCH',
          body: JSON.stringify(payload),
        },
        { authCookieLockHeld: true },
      );
      clearAuthenticatedSession();
      publishAuthCookieTransition(null);
    })
  ),
};
