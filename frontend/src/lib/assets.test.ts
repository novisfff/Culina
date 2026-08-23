import { describe, expect, it } from 'vitest';
import { API_BASE_URL } from '../api/client';
import type { MediaAsset } from '../api/types';
import { buildMediaSizes, buildMediaSrcSet, mediaAccessReferenceFromUrl, resolveMediaUrl, shouldRenewMediaUrl } from './assets';

function mediaAsset(overrides: Partial<MediaAsset> = {}): MediaAsset {
  return {
    id: 'photo-1',
    name: 'cover',
    url: '/api/media/photo-1/content?variant=original&ticket=original-ticket',
    source: 'ai',
    alt: 'cover',
    created_at: '2026-06-11T00:00:00Z',
    ...overrides,
  };
}

describe('media asset helpers', () => {
  it('resolves preferred variants and falls back to the original url', () => {
    const asset = mediaAsset({
      variants: {
        card: {
          url: '/api/media/photo-1/content?variant=card&ticket=card-ticket',
          width: 640,
          height: 480,
          content_type: 'image/webp',
          byte_size: 1024,
        },
      },
    });

    expect(resolveMediaUrl(asset, 'card')).toBe(
      `${API_BASE_URL}/api/media/photo-1/content?variant=card&ticket=card-ticket`,
    );
    expect(resolveMediaUrl(asset, 'large')).toBe(
      `${API_BASE_URL}/api/media/photo-1/content?variant=original&ticket=original-ticket`,
    );
  });

  it('builds a width-based srcset from available variants', () => {
    const asset = mediaAsset({
      variants: {
        thumb: {
          url: '/api/media/photo-1/content?variant=thumb&ticket=thumb-ticket',
          width: 320,
          height: 240,
          content_type: 'image/webp',
          byte_size: 512,
        },
        large: {
          url: '/api/media/photo-1/content?variant=large&ticket=large-ticket',
          width: 1024,
          height: 768,
          content_type: 'image/webp',
          byte_size: 2048,
        },
      },
    });

    expect(buildMediaSrcSet(asset)).toBe(
      [
        `${API_BASE_URL}/api/media/photo-1/content?variant=thumb&ticket=thumb-ticket 320w`,
        `${API_BASE_URL}/api/media/photo-1/content?variant=large&ticket=large-ticket 1024w`,
      ].join(', ')
    );
  });

  it('returns undefined srcset when variants are missing', () => {
    expect(buildMediaSrcSet(mediaAsset())).toBeUndefined();
    expect(buildMediaSizes('thumb')).toContain('96px');
  });

  it('extracts renewable media scope and detects URLs nearing expiry', () => {
    const expired = '/api/media/photo-1/content?variant=card&ticket=old&expires_at=2026-06-11T00%3A00%3A00Z';

    expect(mediaAccessReferenceFromUrl(expired)).toEqual({ mediaId: 'photo-1', variant: 'card' });
    expect(shouldRenewMediaUrl(expired, Date.parse('2026-06-11T00:00:01Z'))).toBe(true);
    expect(shouldRenewMediaUrl('/assets/cover.png', Date.parse('2026-06-11T00:00:01Z'))).toBe(false);
  });
});
