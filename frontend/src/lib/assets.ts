import { mediaApi } from '../api/mediaApi';
import { API_BASE_URL } from '../api/request';
import type { MediaAsset } from '../api/types';

export type MediaDisplaySize = 'thumb' | 'card' | 'large' | 'original';
export type MediaSizesPreset = 'thumb' | 'card' | 'hero';
export type MediaAccessReference = { mediaId: string; variant: MediaDisplaySize };

const MEDIA_ACCESS_RENEWAL_WINDOW_MS = 15_000;
const MEDIA_VARIANTS = new Set<MediaDisplaySize>(['thumb', 'card', 'large', 'original']);

function parsedMediaUrl(url: string): URL | undefined {
  try {
    return new URL(url, 'http://culina.local');
  } catch {
    return undefined;
  }
}

export function mediaAccessReferenceFromUrl(url?: string | null): MediaAccessReference | undefined {
  if (!url) return undefined;
  const parsed = parsedMediaUrl(url);
  const match = parsed?.pathname.match(/^\/api\/media\/([^/]+)\/content$/);
  if (!parsed || !match) return undefined;
  const variant = parsed.searchParams.get('variant') ?? 'original';
  if (!MEDIA_VARIANTS.has(variant as MediaDisplaySize)) return undefined;
  return {
    mediaId: decodeURIComponent(match[1]),
    variant: variant as MediaDisplaySize,
  };
}

export function shouldRenewMediaUrl(url?: string | null, now = Date.now()): boolean {
  if (!url || !mediaAccessReferenceFromUrl(url)) return false;
  const expiresAt = parsedMediaUrl(url)?.searchParams.get('expires_at');
  if (!expiresAt) return false;
  const expiresAtMs = Date.parse(expiresAt);
  return Number.isFinite(expiresAtMs) && expiresAtMs <= now + MEDIA_ACCESS_RENEWAL_WINDOW_MS;
}

export async function renewMediaUrl(url?: string | null): Promise<string | undefined> {
  const reference = mediaAccessReferenceFromUrl(url);
  if (!reference) return undefined;
  const asset = await mediaApi.getMediaAccess(reference.mediaId);
  return resolveMediaUrl(asset, reference.variant);
}

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

export function resolveMediaUrl(asset?: MediaAsset | null, size: MediaDisplaySize = 'original'): string | undefined {
  if (!asset) {
    return undefined;
  }
  const variantUrl = size === 'original' ? undefined : asset.variants?.[size]?.url;
  return resolveAssetUrl(variantUrl ?? asset.url);
}

export function buildMediaSrcSet(asset?: MediaAsset | null): string | undefined {
  if (!asset?.variants) {
    return undefined;
  }
  const entries = (['thumb', 'card', 'large'] as const)
    .map((key) => {
      const variant = asset.variants?.[key];
      const url = resolveAssetUrl(variant?.url);
      return variant && url ? `${url} ${variant.width}w` : '';
    })
    .filter(Boolean);
  return entries.length > 0 ? entries.join(', ') : undefined;
}

export function buildMediaSizes(preset: MediaSizesPreset): string {
  if (preset === 'thumb') {
    return '(max-width: 767px) 96px, 132px';
  }
  if (preset === 'hero') {
    return '(max-width: 767px) 92vw, 760px';
  }
  return '(max-width: 767px) 46vw, 320px';
}
