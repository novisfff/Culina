import { afterEach, describe, expect, it, vi } from 'vitest';
import { synthesizeSpeech } from './aiVoiceApi';

afterEach(() => {
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

    await expect(synthesizeSpeech({ text: '请继续下一步。', surface: 'recipe_cook_page' }))
      .rejects.toMatchObject({
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
