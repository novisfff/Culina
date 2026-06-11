import { describe, expect, it } from 'vitest';
import { API_BASE_URL } from '../api/client';
import type { MediaAsset } from '../api/types';
import { buildMediaSizes, buildMediaSrcSet, resolveMediaUrl } from './assets';

function mediaAsset(overrides: Partial<MediaAsset> = {}): MediaAsset {
  return {
    id: 'photo-1',
    name: 'cover',
    url: '/media/family/cover.png',
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
          url: '/media/family/variants/photo-1/card.webp',
          width: 640,
          height: 480,
          content_type: 'image/webp',
          byte_size: 1024,
        },
      },
    });

    expect(resolveMediaUrl(asset, 'card')).toBe(`${API_BASE_URL}/media/family/variants/photo-1/card.webp`);
    expect(resolveMediaUrl(asset, 'large')).toBe(`${API_BASE_URL}/media/family/cover.png`);
  });

  it('builds a width-based srcset from available variants', () => {
    const asset = mediaAsset({
      variants: {
        thumb: {
          url: '/media/family/variants/photo-1/thumb.webp',
          width: 320,
          height: 240,
          content_type: 'image/webp',
          byte_size: 512,
        },
        large: {
          url: '/media/family/variants/photo-1/large.webp',
          width: 1024,
          height: 768,
          content_type: 'image/webp',
          byte_size: 2048,
        },
      },
    });

    expect(buildMediaSrcSet(asset)).toBe(
      [
        `${API_BASE_URL}/media/family/variants/photo-1/thumb.webp 320w`,
        `${API_BASE_URL}/media/family/variants/photo-1/large.webp 1024w`,
      ].join(', ')
    );
  });

  it('returns undefined srcset when variants are missing', () => {
    expect(buildMediaSrcSet(mediaAsset())).toBeUndefined();
    expect(buildMediaSizes('thumb')).toContain('96px');
  });
});
