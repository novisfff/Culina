import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LoginResponse } from './types';

const AUTH_TRANSITION_SEQUENCE_KEY = 'culina-auth-transition-sequence-v1';

function authPayload(identity: string): LoginResponse {
  return {
    access_token: `${identity}-access-token`,
    user: {
      id: `${identity}-user`,
      username: `${identity}-owner`,
      display_name: `${identity} Owner`,
      avatar_seed: `${identity} Owner`,
    },
    membership: {
      id: `${identity}-membership`,
      family_id: `${identity}-family`,
      user_id: `${identity}-user`,
      role: 'Owner',
      status: 'active',
    },
    family: {
      id: `${identity}-family`,
      name: `${identity} 家庭`,
      motto: '',
      location: '',
      food_preferences: [],
      food_avoidances: [],
      created_at: '2026-08-24T00:00:00Z',
      updated_at: '2026-08-24T00:00:00Z',
      ai_recommendations: [],
    },
  };
}

type MessageListener = (event: MessageEvent<unknown>) => void;

class ControlledBroadcastChannel {
  static instances: ControlledBroadcastChannel[] = [];

  readonly name: string;
  readonly posted: unknown[] = [];
  private readonly listeners = new Set<MessageListener>();

  constructor(name: string) {
    this.name = name;
    ControlledBroadcastChannel.instances.push(this);
  }

  addEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    if (type !== 'message') return;
    const callback: MessageListener = typeof listener === 'function'
      ? (event) => listener(event)
      : (event) => listener.handleEvent(event);
    this.listeners.add(callback);
  }

  postMessage(message: unknown): void {
    this.posted.push(message);
  }

  dispatch(message: unknown): void {
    const event = new MessageEvent('message', { data: message });
    this.listeners.forEach((listener) => listener(event));
  }
}

describe('auth cookie transition coordination', () => {
  beforeEach(() => {
    vi.resetModules();
    localStorage.clear();
    ControlledBroadcastChannel.instances = [];
    vi.stubGlobal('BroadcastChannel', ControlledBroadcastChannel);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  function installImmediateBrowserLock() {
    const lockRequest = vi.fn((
      _name: string,
      _options: LockOptions,
      callback: (lock: Lock | null) => Promise<unknown>,
    ) => callback(null));
    vi.stubGlobal('navigator', { locks: { request: lockRequest } });
    return lockRequest;
  }

  function remoteTransition(channel: ControlledBroadcastChannel, payload: LoginResponse) {
    channel.dispatch({
      sourceId: 'remote-tab',
      sequence: 1,
      payload,
    });
  }

  it('uses the stored sequence as a baseline when a tab starts later', async () => {
    localStorage.setItem(AUTH_TRANSITION_SEQUENCE_KEY, JSON.stringify(7));
    const lockRequest = installImmediateBrowserLock();
    const { authApi } = await import('./authApi');
    const laterSession = authPayload('later');
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify(laterSession), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchSpy);

    await expect(authApi.login('later-owner', 'LaterPass123'))
      .resolves.toEqual(laterSession);

    expect(lockRequest).toHaveBeenCalledOnce();
    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(localStorage.getItem(AUTH_TRANSITION_SEQUENCE_KEY)).toBe('8');
  });

  it('refuses a cookie writer when the auth sequence cannot be read', async () => {
    installImmediateBrowserLock();
    vi.stubGlobal('localStorage', {
      getItem() {
        throw new DOMException('storage disabled', 'SecurityError');
      },
      setItem() {},
      removeItem() {},
    });
    const { authApi } = await import('./authApi');
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify(authPayload('later')), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchSpy);

    await expect(authApi.login('later-owner', 'LaterPass123'))
      .rejects.toThrow('认证状态存储不可用');

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('refuses a cookie writer when the auth sequence cannot be written', async () => {
    installImmediateBrowserLock();
    vi.stubGlobal('localStorage', {
      getItem() {
        return null;
      },
      setItem() {
        throw new DOMException('storage disabled', 'QuotaExceededError');
      },
      removeItem() {},
    });
    const { authApi } = await import('./authApi');
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify(authPayload('later')), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchSpy);

    await expect(authApi.login('later-owner', 'LaterPass123'))
      .rejects.toThrow('认证状态存储不可用');

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('refuses a cookie writer when the auth sequence write cannot be verified', async () => {
    installImmediateBrowserLock();
    vi.stubGlobal('localStorage', {
      getItem() {
        return null;
      },
      setItem() {},
      removeItem() {},
    });
    const { authApi } = await import('./authApi');
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify(authPayload('later')), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchSpy);

    await expect(authApi.login('later-owner', 'LaterPass123'))
      .rejects.toThrow('认证状态存储不可用');

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('refuses a cookie writer when the stored auth sequence is malformed', async () => {
    localStorage.setItem(AUTH_TRANSITION_SEQUENCE_KEY, 'not-json');
    installImmediateBrowserLock();
    const { authApi } = await import('./authApi');
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify(authPayload('later')), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchSpy);

    await expect(authApi.login('later-owner', 'LaterPass123'))
      .rejects.toThrow('认证状态存储不可用');

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('applies a previous identity before a later login writes a different cookie', async () => {
    const lockRequest = installImmediateBrowserLock();
    const request = await import('./request');
    const { authApi } = await import('./authApi');
    const channel = ControlledBroadcastChannel.instances[0];
    expect(channel).toBeDefined();

    const oldSession = authPayload('old');
    const previousSession = authPayload('previous');
    const laterSession = authPayload('later');
    const appliedIdentities: Array<string | null> = [];
    request.subscribeAuthSession((payload) => appliedIdentities.push(payload?.user.id ?? null));
    request.setAuthenticatedSession(oldSession);
    appliedIdentities.length = 0;
    localStorage.setItem(AUTH_TRANSITION_SEQUENCE_KEY, JSON.stringify(1));
    let sharedCookie = 'previous-refresh-cookie';
    const fetchSpy = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(new Headers(init?.headers).get('Authorization'))
        .toBe(`Bearer ${previousSession.access_token}`);
      sharedCookie = 'later-refresh-cookie';
      return new Response(JSON.stringify(laterSession), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchSpy);

    const login = authApi.login('later-owner', 'LaterPass123');
    const loginResult = login.then(
      (value) => ({ status: 'fulfilled' as const, value }),
      (reason: unknown) => ({ status: 'rejected' as const, reason }),
    );
    await vi.waitFor(() => expect(lockRequest).toHaveBeenCalledOnce());
    expect(fetchSpy).not.toHaveBeenCalled();

    remoteTransition(channel, previousSession);
    await expect(loginResult).resolves.toEqual({
      status: 'fulfilled',
      value: laterSession,
    });

    expect(appliedIdentities).toEqual([
      previousSession.user.id,
      laterSession.user.id,
    ]);
    expect(request.getAccessToken()).toBe(laterSession.access_token);
    expect(sharedCookie).toBe('later-refresh-cookie');
    expect(channel.posted).toContainEqual({
      sourceId: expect.any(String),
      sequence: 2,
      payload: laterSession,
    });
  });

  it('applies a new identity before an old password action can clear its cookie', async () => {
    const lockRequest = installImmediateBrowserLock();
    const request = await import('./request');
    const { authApi } = await import('./authApi');
    const channel = ControlledBroadcastChannel.instances[0];
    expect(channel).toBeDefined();

    const oldSession = authPayload('old');
    const previousSession = authPayload('previous');
    request.setAuthenticatedSession(oldSession);
    localStorage.setItem(AUTH_TRANSITION_SEQUENCE_KEY, JSON.stringify(1));
    let sharedCookie: string | null = 'previous-refresh-cookie';
    const fetchSpy = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const authorization = new Headers(init?.headers).get('Authorization');
      if (authorization === `Bearer ${oldSession.access_token}`) {
        sharedCookie = null;
        return new Response(null, { status: 204 });
      }
      expect(authorization).toBe(`Bearer ${previousSession.access_token}`);
      return new Response(JSON.stringify({ detail: '当前密码不正确' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchSpy);

    const password = authApi.updatePassword({
      current_password: 'OldPass123',
      new_password: 'ChangedPass456',
    });
    const passwordResult = password.then(
      () => ({ status: 'fulfilled' as const }),
      (reason: unknown) => ({ status: 'rejected' as const, reason }),
    );
    await vi.waitFor(() => expect(lockRequest).toHaveBeenCalledOnce());
    expect(fetchSpy).not.toHaveBeenCalled();

    remoteTransition(channel, previousSession);
    await expect(passwordResult).resolves.toMatchObject({
      status: 'rejected',
      reason: { status: 400 },
    });

    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(request.getAccessToken()).toBe(previousSession.access_token);
    expect(sharedCookie).toBe('previous-refresh-cookie');
  });
});
