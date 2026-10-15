import assert from 'node:assert/strict';
import { test } from 'node:test';
import { auditProductionDependencies, classifyAudit } from './audit-production-dependencies.mjs';

const clean = { code: 0, stdout: '{"dependencies":[]}', stderr: '' };

test('frontend vulnerabilities do not prevent the backend audit', async () => {
  const calls = [];
  const results = await auditProductionDependencies({ run: async (command) => {
    calls.push(command);
    return command === 'npm' ? { code: 1, stdout: '{"metadata":{"vulnerabilities":{"high":1}}}' } : clean;
  } });
  assert.equal(calls.length, 2);
  assert.deepEqual(results.map((result) => result.status), ['vulnerabilities', 'passed']);
});

test('service failures are retried once and remain failures when unavailable', async () => {
  let calls = 0;
  const results = await auditProductionDependencies({ run: async () => {
    calls += 1;
    return { code: 1, stdout: '{"error":{"code":"E503"}}', stderr: '503 Service Unavailable' };
  }, delay: async () => {} });
  assert.equal(calls, 4);
  assert.ok(results.every((result) => result.status === 'unavailable' && result.attempts.length === 2));
});

test('a successful retry is recorded, while malformed success output fails closed', async () => {
  const counts = new Map();
  const results = await auditProductionDependencies({ run: async (command) => {
    const attempt = (counts.get(command) || 0) + 1;
    counts.set(command, attempt);
    return attempt === 1 ? { code: 1, stdout: 'unavailable' } : command === 'npm' ? { code: 0, stdout: '{"metadata":{"vulnerabilities":{"high":0,"critical":0}}}' } : clean;
  }, delay: async () => {} });
  assert.ok(results.every((result) => result.status === 'passed' && result.attempts.length === 2));
  assert.equal(classifyAudit('backend', { code: 0, stdout: '' }), 'unavailable');
  assert.equal(classifyAudit('backend', { code: 1, stdout: '{"dependencies":[{"vulns":[{"id":"x"}]}]}' }), 'vulnerabilities');
});

test('incomplete JSON schemas are unavailable and cannot crash the other audit', () => {
  for (const payload of [null, { dependencies: {} }, { dependencies: [null] }, { dependencies: [{ skip_reason: 'unsupported dependency' }] }]) {
    assert.equal(classifyAudit('backend', { code: 0, stdout: JSON.stringify(payload) }), 'unavailable');
  }
  for (const vulnerabilities of [{}, { high: '0', critical: 0 }, { high: 0, critical: -1 }]) {
    assert.equal(classifyAudit('frontend', { code: 0, stdout: JSON.stringify({ metadata: { vulnerabilities } }) }), 'unavailable');
  }
});
