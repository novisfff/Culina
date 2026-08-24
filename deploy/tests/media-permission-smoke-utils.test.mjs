import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertNoCapabilityLeak,
  minioObjectUrl,
  parsePublishedPort,
} from './media-permission-smoke-utils.mjs';

test('minioObjectUrl encodes each object-key segment without hiding separators', () => {
  assert.equal(
    minioObjectUrl('http://127.0.0.1:19000', 'culina-media', 'family id/photos/晚餐.png'),
    'http://127.0.0.1:19000/culina-media/family%20id/photos/%E6%99%9A%E9%A4%90.png',
  );
});

test('assertNoCapabilityLeak accepts path-only nginx access logs', () => {
  assert.doesNotThrow(() =>
    assertNoCapabilityLeak(
      'GET /api/media/photo-smoke/content HTTP/1.1 200',
      '/api/media/photo-smoke/content?variant=original&ticket=secret-ticket&expires_at=soon',
    ),
  );
});

test('assertNoCapabilityLeak rejects query names and the actual capability', () => {
  const signedUrl =
    '/api/media/photo-smoke/content?variant=original&ticket=secret-ticket&expires_at=soon';

  assert.throws(
    () => assertNoCapabilityLeak('GET /api/media/photo-smoke/content?ticket=redacted', signedUrl),
    /query parameter/,
  );
  assert.throws(
    () => assertNoCapabilityLeak('upstream failure secret-ticket', signedUrl),
    /capability value/,
  );
});

test('parsePublishedPort reads the dynamically assigned Docker host port', () => {
  assert.equal(parsePublishedPort('127.0.0.1:49152\n'), '49152');
  assert.equal(parsePublishedPort('[::1]:49153'), '49153');
  assert.throws(() => parsePublishedPort(''), /published port/);
});
