import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { parsePublishedPort } from './media-permission-smoke-utils.mjs';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, '..', '..');
const frontendRoot = path.join(repositoryRoot, 'frontend');
const composeFile = path.join(scriptDirectory, 'docker-compose.websocket-smoke.yml');
const projectName = `culina-realtime-websocket-smoke-${process.pid}-${Date.now()}`;
let port = process.env.CULINA_WS_SMOKE_PORT || '0';
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
  const build = process.env.CULINA_SMOKE_PREBUILT === '1' ? ['--no-build', '--pull', 'never'] : ['--build'];
  const up = run('docker', [...compose, 'up', '-d', ...build, '--wait', '--wait-timeout', '180']);
  if (up.status !== 0) exitCode = up.status || 1;
  else {
    port = parsePublishedPort(run('docker', [...compose, 'port', 'frontend', '80'], { capture: true }).stdout);
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
    exitCode = playwright.status ?? 1;
    if (exitCode === 0 && process.env.CULINA_WS_SMOKE_VERIFY_NEGATIVE === '1') {
      const breakUpgrade = run('docker', [...compose, 'exec', '-T', 'frontend', 'sh', '-c',
        'sed -i \'s/proxy_set_header Upgrade $http_upgrade;/proxy_set_header Upgrade "";/\' /etc/nginx/conf.d/default.conf && nginx -s reload']);
      if (breakUpgrade.status !== 0) throw new Error('failed to install negative WebSocket proxy configuration');
      const negative = run(path.join(frontendRoot, 'node_modules', '.bin', 'playwright'), [
        'test', '--config=playwright.deployment.config.mjs', '--grep=preserves the audio payload', '--reporter=line', '--output=test-results/websocket-negative',
      ], { cwd: frontendRoot, env: { ...environment, CULINA_DEPLOYMENT_BASE_URL: `http://127.0.0.1:${port}` } });
      if (negative.status !== 1) throw new Error('WebSocket smoke did not detect the broken Upgrade configuration');
      console.log('Negative WebSocket check passed: broken Upgrade was rejected.');
    }
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
      if (logs.status !== 0) throw new Error('failed to inspect nginx logs');
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
