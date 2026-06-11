import { API_BASE_URL } from '../api/client';
import type { MediaAsset } from '../api/types';

export type MediaDisplaySize = 'thumb' | 'card' | 'large' | 'original';
export type MediaSizesPreset = 'thumb' | 'card' | 'hero';

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
