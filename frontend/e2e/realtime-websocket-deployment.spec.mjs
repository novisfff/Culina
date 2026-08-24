import { expect, test } from '@playwright/test';

test('browser crosses nginx and exchanges a realtime audio event frame', async ({ page }) => {
  await page.goto('/', { waitUntil: 'commit' });
  await page.evaluate(async () => {
    const response = await fetch('/api/health?ticket=query-log-sentinel');
    if (!response.ok) throw new Error(`health request failed: ${response.status}`);
  });

  const result = await page.evaluate(async () => {
    const websocketUrl = `${location.origin.replace(/^http/, 'ws')}/api/ai/realtime/cooking/sessions/smoke-session/ws`;
    const socket = new WebSocket(websocketUrl, [
      'culina-realtime',
      'culina-ticket.smoke-ticket',
    ]);
    return await new Promise((resolve, reject) => {
      const timeout = window.setTimeout(() => reject(new Error('websocket timed out')), 10_000);
      socket.onopen = () => {
        socket.send(JSON.stringify({
          type: 'audio_chunk_done',
          mime_type: 'audio/pcm',
          data: btoa('pcm-audio-frame'),
        }));
      };
      socket.onmessage = (event) => {
        window.clearTimeout(timeout);
        resolve({
          protocol: socket.protocol,
          search: new URL(websocketUrl).search,
          payload: JSON.parse(String(event.data)),
        });
      };
      socket.onerror = () => {
        window.clearTimeout(timeout);
        reject(new Error('websocket failed'));
      };
    });
  });

  expect(result.protocol).toBe('culina-realtime');
  expect(result.search).toBe('');
  expect(result.payload).toEqual({
    type: 'audio_ack',
    session_id: 'smoke-session',
    byte_length: 15,
  });
});
