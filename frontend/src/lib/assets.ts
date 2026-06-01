import { API_BASE_URL } from '../api/client';

export function resolveAssetUrl(
  url?: string | null,
  options: { passthroughPrefixes?: string[] } = {}
): string | undefined {
  if (!url) {
    return undefined;
  }
  if (url.startsWith('http://') || url.startsWith('https://') || url.startsWith('data:')) {
    return url;
  }
  if (options.passthroughPrefixes?.some((prefix) => url.startsWith(prefix))) {
    return url;
  }
  return `${API_BASE_URL}${url}`;
}
