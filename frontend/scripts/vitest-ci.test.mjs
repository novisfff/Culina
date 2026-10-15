// @vitest-environment node
import { expect, test } from 'vitest';
import { summarizeVitest, validateShardFiles } from './vitest-ci.mjs';

test('missing, duplicate and mismatched shards cannot produce a merged pass', () => {
  expect(() => validateShardFiles(['blob-1-2.json'], 2)).toThrow(/Incomplete/);
  expect(() => validateShardFiles(['blob-1-2.json', 'blob-1-2.json'], 2)).toThrow(/Incomplete/);
  expect(() => validateShardFiles(['blob-1-3.json', 'blob-2-3.json'], 2)).toThrow(/Incomplete/);
  expect(() => validateShardFiles(['blob-2-2.json', 'blob-1-2.json'], 2)).not.toThrow();
});

test('results expose executed counts and reject failed, empty or duplicated test files', () => {
  const result = { success: true, numTotalTests: 3, numPassedTests: 3, numPendingTests: 0, testResults: [{ name: 'a', startTime: 1, endTime: 3 }] };
  expect(summarizeVitest(result)).toMatchObject({ tests: 3, files: 1, slowFiles: [{ file: 'a', durationMs: 2 }] });
  expect(() => summarizeVitest({ ...result, success: false })).toThrow();
  expect(() => summarizeVitest({ ...result, numTotalTests: 0 })).toThrow();
  expect(() => summarizeVitest({ ...result, testResults: [...result.testResults, ...result.testResults] })).toThrow(/multiple/);
});
