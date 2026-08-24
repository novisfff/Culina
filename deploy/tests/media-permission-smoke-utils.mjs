export function minioObjectUrl(endpoint, bucket, objectKey) {
  const encodedBucket = encodeURIComponent(bucket);
  const encodedKey = objectKey.split('/').map(encodeURIComponent).join('/');
  return `${endpoint.replace(/\/$/, '')}/${encodedBucket}/${encodedKey}`;
}

export function parsePublishedPort(composePortOutput) {
  const binding = String(composePortOutput).trim().split(/\r?\n/, 1)[0];
  const match = binding.match(/:(\d+)$/);
  const port = Number(match?.[1]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Could not determine Docker published port from ${JSON.stringify(binding)}`);
  }
  return String(port);
}

export function assertNoCapabilityLeak(logs, signedUrl) {
  const parsed = new URL(signedUrl, 'http://culina-smoke.invalid');
  for (const parameter of ['ticket', 'expires_at']) {
    if (logs.includes(`${parameter}=`)) {
      throw new Error(`nginx logs exposed media capability query parameter ${parameter}`);
    }
  }

  for (const parameter of ['ticket', 'expires_at']) {
    const value = parsed.searchParams.get(parameter);
    if (value && logs.includes(value)) {
      throw new Error(`nginx logs exposed media capability value ${parameter}`);
    }
  }

  if (parsed.search && logs.includes(parsed.search)) {
    throw new Error('nginx logs exposed the media capability query string');
  }
}
