import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import {
  assertNoCapabilityLeak,
  minioObjectUrl,
  parsePublishedPort,
} from './media-permission-smoke-utils.mjs';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, '..', '..');
const composeFile = path.join(scriptDirectory, 'docker-compose.media-permission-smoke.yml');
const projectName = `culina-media-permission-smoke-${process.pid}-${Date.now()}`;
const environment = { ...process.env };
const compose = ['compose', '-p', projectName, '-f', composeFile];
let frontendOrigin = '';
let minioOrigin = '';
const ownerCredentials = {
  username: 'media-smoke-owner',
  password: 'MediaSmokeOwner123',
};
const otherCredentials = {
  username: 'media-smoke-other-household',
  password: 'MediaSmokeOther123',
};
const tinyPng = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEklEQVR4nGO8lG3MwMDAxAAGABIJAXTuw8HUAAAAAElFTkSuQmCC',
  'base64',
);

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: repositoryRoot,
    env: environment,
    encoding: 'utf8',
    stdio: options.capture ? 'pipe' : 'inherit',
  });
  if (result.error) throw result.error;
  if (!options.allowFailure && result.status !== 0) {
    const detail = options.capture
      ? `\n${result.stdout || ''}${result.stderr || ''}`.trimEnd()
      : '';
    throw new Error(`${command} ${args.join(' ')} exited with ${result.status}${detail}`);
  }
  return result;
}

async function fetchForSmoke(resource, options, label) {
  try {
    return await fetch(resource, options);
  } catch {
    throw new Error(`${label} request failed`);
  }
}

async function expectStatus(response, expected, label) {
  if (response.status === expected) return;
  const body = (await response.text()).slice(0, 500);
  throw new Error(`${label} returned ${response.status}; expected ${expected}; body=${body}`);
}

async function login(credentials, label) {
  const response = await fetchForSmoke(
    `${frontendOrigin}/api/auth/login`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: frontendOrigin,
      },
      body: JSON.stringify(credentials),
    },
    label,
  );
  await expectStatus(response, 200, label);
  const payload = await response.json();
  if (typeof payload.access_token !== 'string' || !payload.access_token) {
    throw new Error(`${label} did not return an access token`);
  }
  return payload.access_token;
}

async function runSmoke() {
  run('docker', [...compose, 'up', '-d', '--build', '--wait', '--wait-timeout', '240']);
  const frontendPort = parsePublishedPort(
    run('docker', [...compose, 'port', 'frontend', '80'], { capture: true }).stdout,
  );
  const minioPort = parsePublishedPort(
    run('docker', [...compose, 'port', 'minio', '9000'], { capture: true }).stdout,
  );
  frontendOrigin = `http://127.0.0.1:${frontendPort}`;
  minioOrigin = `http://127.0.0.1:${minioPort}`;
  run('docker', [
    ...compose,
    'exec',
    '-T',
    '-e',
    'CULINA_MEDIA_PERMISSION_SMOKE=1',
    'backend',
    'python',
    '-m',
    'scripts.seed_media_permission_smoke',
  ]);

  const ownerToken = await login(ownerCredentials, 'owner login');
  const uploadForm = new FormData();
  uploadForm.set('file', new Blob([tinyPng], { type: 'image/png' }), 'media-smoke.png');
  uploadForm.set('source', 'upload');
  uploadForm.set('alt', '媒体权限 smoke');
  const uploadResponse = await fetchForSmoke(
    `${frontendOrigin}/api/media/upload`,
    {
      method: 'POST',
      headers: { authorization: `Bearer ${ownerToken}` },
      body: uploadForm,
    },
    'media upload',
  );
  await expectStatus(uploadResponse, 201, 'media upload');
  const uploaded = await uploadResponse.json();
  if (typeof uploaded.id !== 'string' || typeof uploaded.url !== 'string') {
    throw new Error('media upload response omitted its id or signed URL');
  }

  const signedContentResponse = await fetchForSmoke(
    new URL(uploaded.url, frontendOrigin),
    undefined,
    'signed media content',
  );
  await expectStatus(signedContentResponse, 200, 'signed media content');
  const signedContent = Buffer.from(await signedContentResponse.arrayBuffer());
  if (!signedContent.equals(tinyPng)) {
    throw new Error('signed media content did not match the uploaded image');
  }

  const unauthenticatedResponse = await fetchForSmoke(
    `${frontendOrigin}/api/media/${encodeURIComponent(uploaded.id)}/access`,
    undefined,
    'unauthenticated media access',
  );
  await expectStatus(unauthenticatedResponse, 401, 'unauthenticated media access');

  const otherToken = await login(otherCredentials, 'other-household login');
  const crossFamilyResponse = await fetchForSmoke(
    `${frontendOrigin}/api/media/${encodeURIComponent(uploaded.id)}/access`,
    { headers: { authorization: `Bearer ${otherToken}` } },
    'cross-family media access',
  );
  await expectStatus(crossFamilyResponse, 404, 'cross-family media access');

  if (!/^[A-Za-z0-9_-]+$/.test(uploaded.id)) {
    throw new Error('media upload returned an unsafe id for the smoke query');
  }
  const objectQuery = run(
    'docker',
    [
      ...compose,
      'exec',
      '-T',
      'mysql',
      'mysql',
      '--user=culina_smoke',
      '--password=culina-media-smoke-db-password',
      '--database=culina_media_permission_smoke',
      '--batch',
      '--skip-column-names',
      '--execute',
      `SELECT file_path FROM media_assets WHERE id = '${uploaded.id}'`,
    ],
    { capture: true },
  );
  const objectKeys = objectQuery.stdout.trim().split(/\r?\n/).filter(Boolean);
  if (objectKeys.length !== 1) {
    throw new Error(`expected one media object key from MySQL, received ${objectKeys.length}`);
  }
  const objectKey = objectKeys[0];

  const rawNginxResponse = await fetchForSmoke(
    `${frontendOrigin}/media/${objectKey.split('/').map(encodeURIComponent).join('/')}`,
    undefined,
    'raw nginx media path',
  );
  const rawNginxContent = Buffer.from(await rawNginxResponse.arrayBuffer());
  const rawNginxContentType = rawNginxResponse.headers.get('content-type') || '';
  if (rawNginxContent.equals(tinyPng) || rawNginxContentType.startsWith('image/')) {
    throw new Error('raw nginx media path exposed image bytes');
  }

  const anonymousMinioResponse = await fetchForSmoke(
    minioObjectUrl(minioOrigin, 'culina-media', objectKey),
    undefined,
    'anonymous MinIO object access',
  );
  await expectStatus(anonymousMinioResponse, 403, 'anonymous MinIO object access');

  const frontendLogs = run('docker', [...compose, 'logs', '--no-color', 'frontend'], {
    capture: true,
  });
  assertNoCapabilityLeak(
    `${frontendLogs.stdout || ''}${frontendLogs.stderr || ''}`,
    uploaded.url,
  );
}

let failure = null;
try {
  await runSmoke();
  console.log('Media permission deployment smoke passed');
} catch (error) {
  failure = error;
  console.error(error instanceof Error ? error.message : error);
  console.error('Compose status:');
  run('docker', [...compose, 'ps', '--all'], { allowFailure: true });
  console.error('Compose logs:');
  run('docker', [...compose, 'logs', '--no-color'], { allowFailure: true });
} finally {
  const down = run(
    'docker',
    [...compose, 'down', '--volumes', '--remove-orphans', '--rmi', 'local'],
    {
      allowFailure: true,
    },
  );
  if (down.status !== 0 && failure === null) {
    failure = new Error(`docker compose cleanup exited with ${down.status}`);
  }
}

if (failure !== null) process.exitCode = 1;
