#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

function execute(command, args) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const timeout = setTimeout(() => child.kill('SIGTERM'), 240_000);
    child.once('error', (error) => { stderr += error.message; });
    child.once('close', (code, signal) => {
      clearTimeout(timeout);
      resolve({ code, signal, stdout, stderr, durationSeconds: (Date.now() - started) / 1000 });
    });
  });
}

export function classifyAudit(name, result) {
  let payload;
  try { payload = JSON.parse(result.stdout); } catch { /* Incomplete service responses fail closed below. */ }
  const counts = payload?.metadata?.vulnerabilities;
  const dependencies = payload?.dependencies;
  const validCount = (value) => Number.isInteger(value) && value >= 0;
  const vulnerabilities = name === 'frontend'
    ? [counts?.high, counts?.critical].filter(validCount).reduce((sum, value) => sum + value, 0)
    : Array.isArray(dependencies) ? dependencies.reduce((sum, dependency) => sum + (Array.isArray(dependency?.vulns) ? dependency.vulns.length : 0), 0) : 0;
  if (vulnerabilities > 0) return 'vulnerabilities';
  const complete = name === 'frontend'
    ? validCount(counts?.high) && validCount(counts?.critical)
    : Array.isArray(dependencies) && dependencies.every((dependency) => Array.isArray(dependency?.vulns));
  if (result.code === 0 && complete && !payload.error) return 'passed';
  return 'unavailable';
}

export async function auditProductionDependencies({ run = execute, delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {}) {
  const commands = [
    ['frontend', 'npm', ['audit', '--prefix', 'frontend', '--omit=dev', '--audit-level=high', '--json']],
    ['backend', 'backend/.venv/bin/python', ['-m', 'pip_audit', '-r', 'backend/requirements.txt', '--format=json']],
  ];
  return Promise.all(commands.map(async ([name, command, args]) => {
    const attempts = [];
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const result = await run(command, args);
      const status = classifyAudit(name, result);
      attempts.push({ ...result, status });
      if (status !== 'unavailable' || attempt === 1) break;
      await delay(1000);
    }
    return { name, status: attempts.at(-1).status, attempts };
  }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const results = await auditProductionDependencies();
  const directory = '.artifacts/dependency-audit';
  mkdirSync(directory, { recursive: true });
  for (const result of results) {
    writeFileSync(`${directory}/${result.name}.json`, `${JSON.stringify(result, null, 2)}\n`);
    console.log(`${result.name}: ${result.status} (${result.attempts.length} attempt(s))`);
  }
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `\n### Production dependency audit\n\n| Graph | Result | Attempts |\n| --- | --- | --- |\n${results.map((r) => `| ${r.name} | ${r.status} | ${r.attempts.length} |`).join('\n')}\n`);
  }
  process.exitCode = results.every((result) => result.status === 'passed') ? 0 : 1;
}
