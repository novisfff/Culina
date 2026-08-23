import { afterEach, describe, expect, it, vi } from 'vitest';
import * as aiVoiceApi from './aiVoiceApi';
import { setAccessToken } from './request';

afterEach(() => {
  setAccessToken(null);
  vi.unstubAllGlobals();
});

describe('synthesizeSpeech', () => {
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
