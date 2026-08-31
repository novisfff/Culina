#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const ALLOWED_SCOPES = new Set([
  'src/api',
  'src/app',
  'src/auth',
  'src/components',
  'src/features',
  'src/hooks',
  'src/lib',
  'scripts',
]);

function readScopes(value) {
  let scopes;
  try {
    scopes = JSON.parse(value ?? '[]');
  } catch (error) {
    throw new Error(`FRONTEND_TEST_SCOPES 不是合法 JSON: ${error instanceof Error ? error.message : error}`);
  }
  if (!Array.isArray(scopes) || scopes.length === 0) throw new Error('没有可运行的前端业务域测试范围');
  const normalized = [...new Set(scopes)];
  const invalid = normalized.filter((scope) => ![...ALLOWED_SCOPES].some((allowed) => scope === allowed || scope.startsWith(`${allowed}/`)));
  if (invalid.length) throw new Error(`存在未登记的前端测试范围: ${invalid.join(', ')}`);
  return normalized;
}

export function runFrontendDomainTests({ scopesValue = process.env.FRONTEND_TEST_SCOPES, spawn = spawnSync } = {}) {
  const scopes = readScopes(scopesValue);
  const command = ['run', 'frontend:test', '--', ...scopes];
  const result = spawn('npm', command, { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exitCode = result.status ?? 1;
  return { scopes, command, status: result.status };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    runFrontendDomainTests();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
