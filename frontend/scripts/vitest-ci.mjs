import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export function validateShardFiles(files, count) {
  if (!Number.isInteger(count) || count < 1) throw new Error('A positive VITEST_SHARD_COUNT is required');
  const expected = Array.from({ length: count }, (_, index) => `blob-${index + 1}-${count}.json`);
  if (files.length !== count || expected.some((file) => !files.includes(file))) {
    throw new Error(`Incomplete Vitest shard artifacts: expected ${expected.join(', ')}; got ${files.join(', ')}`);
  }
}

export function summarizeVitest(result) {
  const files = result.testResults;
  if (!result.success || !(result.numTotalTests > 0) || !Array.isArray(files) || !files.length) {
    throw new Error('Vitest result is failed, empty or incomplete');
  }
  if (new Set(files.map((file) => file.name)).size !== files.length) throw new Error('A test file was executed in multiple shards');
  return {
    files: files.length,
    tests: result.numTotalTests,
    passed: result.numPassedTests,
    skipped: result.numPendingTests,
    slowFiles: files.map((file) => ({ file: file.name, durationMs: file.endTime - file.startTime }))
      .sort((a, b) => b.durationMs - a.durationMs).slice(0, 15),
  };
}

function vitest(args) {
  const result = spawnSync(process.execPath, ['node_modules/vitest/vitest.mjs', ...args], { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Vitest exited with ${result.status ?? result.signal}`);
}

export function main(mode, env = process.env) {
  mkdirSync('coverage', { recursive: true });
  if (mode === 'shard') {
    const match = /^(\d+)\/(\d+)$/.exec(env.VITEST_SHARD || '');
    if (!match || Number(match[1]) < 1 || Number(match[1]) > Number(match[2])) throw new Error('VITEST_SHARD must be index/count');
    if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `shard_count=${match[2]}\n`);
    vitest(['run', '--coverage', `--shard=${env.VITEST_SHARD}`, '--reporter=default', '--reporter=blob', '--reporter=json', `--outputFile.json=coverage/shard-${match[1]}.json`]);
  } else if (mode === 'merge') {
    validateShardFiles(readdirSync('.vitest-reports'), Number(env.VITEST_SHARD_COUNT));
    // Vitest merges Istanbul statement/function/branch maps from its blob
    // reports. Percentages and duplicate per-shard denominators are never added.
    vitest(['run', '--merge-reports=.vitest-reports', '--coverage', '--reporter=json', '--outputFile=coverage/vitest-results.json']);
    const summary = summarizeVitest(JSON.parse(readFileSync('coverage/vitest-results.json', 'utf8')));
    if (!JSON.parse(readFileSync('coverage/coverage-summary.json', 'utf8')).total) throw new Error('Missing merged coverage');
    writeFileSync('coverage/ci-summary.json', `${JSON.stringify(summary, null, 2)}\n`);
    if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `\n### Vitest\n\n${summary.files} files; ${summary.tests} tests; ${summary.passed} passed; ${summary.skipped} skipped.\n\n| Slow file | ms |\n| --- | --- |\n${summary.slowFiles.map((file) => `| ${file.file} | ${file.durationMs} |`).join('\n')}\n`);
  } else throw new Error('Expected shard or merge');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv[2]);
