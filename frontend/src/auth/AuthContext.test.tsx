import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useState } from 'react';

import {
  clearAuthenticatedSession,
  getAccessToken,
  setAccessToken,
  setAuthenticatedSession,
} from '../api/request';
import type { LoginResponse } from '../api/types';
import { AuthProvider, useAuth } from './AuthContext';

const authPayload: LoginResponse = {
  access_token: 'fresh-access-token',
  user: {
    id: 'user-a',
    username: 'owner',
    display_name: 'Owner',
    avatar_seed: 'Owner',
  },
  membership: {
    id: 'membership-a',
    family_id: 'family-a',
    user_id: 'user-a',
    role: 'Owner',
    status: 'active',
  },
  family: {
    id: 'family-a',
    name: '测试家庭',
    motto: '',
    location: '',
    food_preferences: [],
    food_avoidances: [],
    created_at: '2026-08-24T00:00:00Z',
    updated_at: '2026-08-24T00:00:00Z',
    ai_recommendations: [],
  },
};

const otherAuthPayload: LoginResponse = {
  ...authPayload,
  access_token: 'other-access-token',
  user: {
    ...authPayload.user,
    id: 'user-b',
    username: 'other-owner',
    display_name: 'Other Owner',
  },
  membership: {
    ...authPayload.membership,
    id: 'membership-b',
    family_id: 'family-b',
    user_id: 'user-b',
  },
  family: {
    ...authPayload.family,
    id: 'family-b',
    name: '另一个家庭',
  },
};

function Probe() {
  const auth = useAuth();
  const [logoutError, setLogoutError] = useState('');
  return (
    <div>
      <span>{auth.user?.display_name ?? 'anonymous'}</span>
      <span>{auth.isAuthenticated ? 'authenticated' : 'signed-out'}</span>
      <span>{auth.isInitializing ? 'initializing' : 'initialized'}</span>
      <button
        type="button"
        onClick={() => {
          void auth.logout().catch((reason) => {
            setLogoutError(reason instanceof Error ? reason.message : 'logout failed');
          });
        }}
      >
        logout
      </button>
      {logoutError && <span>{logoutError}</span>}
    </div>
  );
}

function renderAuth() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const rendered = render(
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <Probe />
      </AuthProvider>
    </QueryClientProvider>,
  );
  return { ...rendered, queryClient };
}

afterEach(() => {
  vi.unstubAllGlobals();
  setAccessToken(null);
});

describe('AuthProvider refresh sessions', () => {
  it('distinguishes refresh-cookie bootstrap from login submission loading', async () => {
    let releaseRefresh: (() => void) | undefined;
    const refreshGate = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });
    vi.stubGlobal('fetch', vi.fn(async () => {
      await refreshGate;
      return new Response(JSON.stringify({ detail: 'no refresh session' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      });
    }));

    renderAuth();

    expect(screen.getByText('initializing')).toBeInTheDocument();
    releaseRefresh?.();
    expect(await screen.findByText('initialized')).toBeInTheDocument();
    expect(screen.getByText('signed-out')).toBeInTheDocument();
  });

  it('bootstraps from the HttpOnly refresh cookie and reacts to session clearing', async () => {
    const fetchSpy = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      const payload = path.endsWith('/api/auth/refresh')
        ? authPayload
        : {
            user: authPayload.user,
            membership: authPayload.membership,
            family: authPayload.family,
          };
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchSpy);

    renderAuth();

    expect(await screen.findByText('Owner')).toBeInTheDocument();
    expect(screen.getByText('authenticated')).toBeInTheDocument();
    expect(getAccessToken()).toBe('fresh-access-token');
    expect(fetchSpy.mock.calls.filter(([input]) => String(input).endsWith('/api/auth/refresh'))).toHaveLength(1);

    clearAuthenticatedSession();

    expect(await screen.findByText('anonymous')).toBeInTheDocument();
    expect(screen.getByText('signed-out')).toBeInTheDocument();
  });

  it('keeps the authenticated UI when server logout cannot be confirmed', async () => {
    const fetchSpy = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).endsWith('/api/auth/logout')) {
        throw new TypeError('network offline');
      }
      return new Response(JSON.stringify(authPayload), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchSpy);
    renderAuth();
    expect(await screen.findByText('Owner')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'logout' }));

    expect(await screen.findByText('network offline')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText('authenticated')).toBeInTheDocument());
    expect(getAccessToken()).toBe('fresh-access-token');
  });

  it('clears family caches before switching between non-null identities', async () => {
    vi.stubGlobal('fetch', vi.fn(async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const isOtherIdentity = new Headers(init?.headers).get('Authorization')
        === 'Bearer other-access-token';
      const payload = String(input).endsWith('/api/auth/refresh')
        ? authPayload
        : isOtherIdentity
          ? otherAuthPayload
          : authPayload;
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }));
    const { queryClient } = renderAuth();
    expect(await screen.findByText('Owner')).toBeInTheDocument();
    queryClient.setQueryData(['private-family-data'], { familyId: 'family-a' });

    setAuthenticatedSession(otherAuthPayload);

    expect(await screen.findByText('Other Owner')).toBeInTheDocument();
    expect(queryClient.getQueryData(['private-family-data'])).toBeUndefined();
    expect(queryClient.getQueryData(['auth', 'me'])).toMatchObject({
      user: { id: 'user-b' },
      family: { id: 'family-b' },
    });
  });
});
