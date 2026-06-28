import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PhotoAsset } from './types';
import { fileToPhoto, generateAiCover } from './media';

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('media helpers', () => {
  it('generates deterministic AI cover metadata and SVG data URL shape', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-28T12:00:00.000Z'));
    vi.spyOn(Math, 'random').mockReturnValue(0.123456789);

    const cover = generateAiCover('番茄炒蛋', 'user-1');

    expect(cover).toMatchObject({
      id: 'photo-4fzzzxjy',
      name: '番茄炒蛋-ai-cover',
      source: 'ai',
      alt: '番茄炒蛋 的 AI 封面',
      generationMode: 'text',
      styleKey: 'culina-still-life-v1',
      promptVersion: '4',
      createdAt: '2026-06-28T12:00:00.000Z',
      createdBy: 'user-1',
    });
    expect(cover.url).toMatch(/^data:image\/svg\+xml;charset=UTF-8,/);
    expect(decodeURIComponent(cover.url.split(',')[1] ?? '')).toContain('<svg width="1200" height="800"');
  });

  it('converts an uploaded file into a photo asset', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-28T12:00:00.000Z'));
    vi.spyOn(Math, 'random').mockReturnValue(0.25);
    const file = new File(['hello'], 'cover.png', { type: 'image/png' });

    const photoPromise = fileToPhoto(file, 'user-2');
    await vi.runAllTimersAsync();
    const photo = await photoPromise as PhotoAsset & { updatedAt: string; updatedBy: string };

    expect(photo).toMatchObject({
      name: 'cover.png',
      source: 'upload',
      alt: 'cover.png',
      createdBy: 'user-2',
      updatedBy: 'user-2',
    });
    expect(photo.id).toMatch(/^photo-/);
    expect(photo.createdAt).toBe(photo.updatedAt);
    expect(new Date(photo.createdAt).toISOString()).toBe(photo.createdAt);
    expect(photo.url).toMatch(/^data:image\/png;base64,/);
  });
});
