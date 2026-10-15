import { expect, test } from '@playwright/test';

test('nginx upgrades the connection and preserves the audio payload and subprotocol', async ({ page }) => {
  await page.goto('/?q=query-log-sentinel');
  const result = await page.evaluate(() => new Promise((resolve, reject) => {
    const url = new URL('/api/ai/realtime/cooking/sessions/smoke/ws', location.href);
    url.protocol = 'ws:';
    const socket = new WebSocket(url, ['culina-realtime', 'culina-ticket.smoke-ticket']);
    const timeout = setTimeout(() => { socket.close(); reject(new Error('WebSocket handshake/response timed out')); }, 8_000);
    let ack;
    socket.onopen = () => socket.send(JSON.stringify({ type: 'audio_chunk_done', data: btoa(String.fromCharCode(0, 1, 127, 255)) }));
    socket.onmessage = (event) => { ack = JSON.parse(event.data); };
    socket.onerror = () => { clearTimeout(timeout); reject(new Error('WebSocket proxy handshake failed')); };
    socket.onclose = (event) => { clearTimeout(timeout); resolve({ ack, protocol: socket.protocol, code: event.code }); };
  }));
  expect(result).toEqual({ ack: { type: 'audio_ack', session_id: 'smoke', byte_length: 4 }, protocol: 'culina-realtime', code: 1000 });
});

test('nginx does not turn an unauthenticated WebSocket into an accepted connection', async ({ page }) => {
  await page.goto('/');
  const accepted = await page.evaluate(() => new Promise((resolve, reject) => {
    const url = new URL('/api/ai/realtime/cooking/sessions/smoke/ws', location.href);
    url.protocol = 'ws:';
    const socket = new WebSocket(url, ['culina-realtime']);
    const timeout = setTimeout(() => { socket.close(); reject(new Error('WebSocket rejection timed out')); }, 8_000);
    socket.onopen = () => { clearTimeout(timeout); socket.close(); resolve(true); };
    socket.onerror = () => { clearTimeout(timeout); resolve(false); };
  }));
  expect(accepted).toBe(false);
});
