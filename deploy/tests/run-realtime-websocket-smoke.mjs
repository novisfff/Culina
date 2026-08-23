import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, '..', '..');
const frontendRoot = path.join(repositoryRoot, 'frontend');
const composeFile = path.join(scriptDirectory, 'docker-compose.websocket-smoke.yml');
const projectName = 'culina-realtime-websocket-smoke';
const port = process.env.CULINA_WS_SMOKE_PORT || '18080';
const environment = { ...process.env, CULINA_WS_SMOKE_PORT: port };
const compose = ['compose', '-p', projectName, '-f', composeFile];

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || repositoryRoot,
    env: options.env || environment,
    encoding: 'utf8',
    stdio: options.capture ? 'pipe' : 'inherit',
  });
  if (result.error) throw result.error;
  return result;
}

async function waitForFrontend() {
  const deadline = Date.now() + 30_000;
  const url = `http://127.0.0.1:${port}/`;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // The nginx container can be running before its port is accepting traffic.
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`frontend nginx did not become ready at ${url}`);
}

let exitCode = 1;
try {
  const up = run('docker', [...compose, 'up', '-d', '--build', '--wait', '--wait-timeout', '180']);
  if (up.status !== 0) process.exitCode = up.status || 1;
  else {
    await waitForFrontend();
    const playwright = run(
      path.join(repositoryRoot, 'frontend', 'node_modules', '.bin', 'playwright'),
      [
        'test',
        'e2e/realtime-websocket-deployment.spec.mjs',
        '--config=playwright.deployment.config.mjs',
      ],
      {
        cwd: frontendRoot,
        env: {
          ...environment,
          CULINA_DEPLOYMENT_BASE_URL: `http://127.0.0.1:${port}`,
        },
      },
    );
    exitCode = playwright.status || 0;
    if (exitCode === 0) {
      const stopBackend = run('docker', [...compose, 'stop', 'backend']);
      if (stopBackend.status !== 0) {
        throw new Error('failed to stop smoke backend before nginx error-log verification');
      }
      const failedMediaResponse = await fetch(
        `http://127.0.0.1:${port}/api/media/smoke/content?variant=original&ticket=media-error-log-sentinel`,
      );
      if (failedMediaResponse.status < 500) {
        throw new Error('failed media capability request did not reach nginx upstream failure path');
      }
      const logs = run('docker', [...compose, 'logs', '--no-color', 'frontend'], { capture: true });
      const output = `${logs.stdout || ''}${logs.stderr || ''}`;
      if (
        output.includes('query-log-sentinel')
        || output.includes('smoke-ticket')
        || output.includes('media-error-log-sentinel')
      ) {
        throw new Error('nginx access logs exposed a query or websocket ticket');
      }
    }
  }
} finally {
  const down = run('docker', [...compose, 'down', '--remove-orphans']);
  if (down.status !== 0 && exitCode === 0) exitCode = down.status || 1;
}

process.exitCode = exitCode;
