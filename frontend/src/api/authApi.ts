import { request } from './request';
import type { LoginResponse } from './types';

export const authApi = {
  login: (username: string, password: string) =>
    request<LoginResponse>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    }),
  me: () => request<LoginResponse>('/api/auth/me'),
  logout: () => request<void>('/api/auth/logout', { method: 'POST' }),
  updateMe: (payload: { display_name: string; email?: string | null; phone?: string | null; avatar_seed?: string | null; avatar_media_id?: string | null; pending_image_job_id?: string | null }) =>
    request<LoginResponse['user']>('/api/auth/me', {
      method: 'PATCH',
      body: JSON.stringify(payload),
    }),
  updatePassword: (payload: { current_password: string; new_password: string }) =>
    request<void>('/api/auth/password', {
      method: 'PATCH',
      body: JSON.stringify(payload),
    }),
};
