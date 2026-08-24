import { afterEach, describe, expect, it, vi } from 'vitest';
import * as aiVoiceApi from './aiVoiceApi';
import { setAccessToken } from './request';
import type { LoginResponse } from './types';

const refreshedSession: LoginResponse = {
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

afterEach(() => {
  setAccessToken(null);
  vi.unstubAllGlobals();
});

describe('synthesizeSpeech', () => {
  it('refreshes and retries an unauthorized audio request with cookies included', async () => {
    setAccessToken('expired-access-token');
    const fetchSpy = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path.endsWith('/api/auth/refresh')) {
        return new Response(JSON.stringify(refreshedSession), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      const authorization = new Headers(init?.headers).get('Authorization');
      if (authorization === 'Bearer expired-access-token') {
        return new Response(null, { status: 401 });
      }
      return new Response('audio-bytes', {
        status: 200,
        headers: { 'Content-Type': 'audio/mpeg' },
      });
    });
    vi.stubGlobal('fetch', fetchSpy);

    const audio = await aiVoiceApi.synthesizeSpeech({
      text: '请继续下一步。',
      surface: 'recipe_cook_page',
    });

    expect(audio).toMatchObject({ size: 11, type: 'audio/mpeg' });
    expect(fetchSpy.mock.calls).toHaveLength(3);
    expect(fetchSpy.mock.calls.every(([, init]) => init?.credentials === 'include')).toBe(true);
    expect(new Headers(fetchSpy.mock.calls[2]?.[1]?.headers).get('Authorization'))
      .toBe('Bearer fresh-access-token');
  });

  it('preserves a structured API error payload for stable usage-limit handling', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      detail: {
        code: 'model_usage_capability_limit_exceeded',
        message: '当前语音额度受限，请改用文字阅读。',
      },
    }), {
      status: 429,
      statusText: 'Too Many Requests',
      headers: { 'Content-Type': 'application/json' },
    })));

    await expect(aiVoiceApi.synthesizeSpeech({
      text: '请继续下一步。',
      surface: 'recipe_cook_page',
    })).rejects.toMatchObject({
      status: 429,
      path: '/api/ai/audio/speech',
      payload: {
        detail: {
          code: 'model_usage_capability_limit_exceeded',
        },
      },
    });
  });
});

describe('realtime voice websocket authentication', () => {
  it('never puts the access token in the websocket URL', () => {
    setAccessToken('seven-day-access-token');

    const url = aiVoiceApi.cookingRealtimeWebSocketUrl(
      '/api/ai/realtime/cooking/sessions/voice-a/ws',
    );

    expect(url).not.toContain('seven-day-access-token');
    expect(new URL(url).search).toBe('');
  });

  it('offers the short-lived ticket as a websocket subprotocol', () => {
    const protocols = (
      aiVoiceApi as typeof aiVoiceApi & {
        cookingRealtimeWebSocketProtocols: (ticket: string) => string[];
      }
    ).cookingRealtimeWebSocketProtocols('ticket-a');

    expect(protocols).toEqual([
      'culina-realtime',
      'culina-ticket.ticket-a',
    ]);
  });
});
