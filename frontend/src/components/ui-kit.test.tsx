import { afterEach, describe, expect, it } from 'vitest';
import type { ImageInputValue } from '../api/types';
import { cleanupTestDomAndMocks, renderWithQuery } from '../test/renderWithQuery';
import { ImageComposer } from './ui-kit';

const generatedImage: ImageInputValue = {
  generatedAsset: {
    id: 'media-ginger',
    name: 'ginger',
    url: '/ginger.jpg',
    source: 'ai',
    alt: '姜',
    created_at: '2026-06-28T00:00:00Z',
  },
};

afterEach(() => {
  cleanupTestDomAndMocks();
});

describe('ImageComposer', () => {
  it('renders action icons with explicit svg paint attributes', async () => {
    const rendered = await renderWithQuery(
      <ImageComposer
        title="食材图片"
        value={generatedImage}
        previewLabel="姜"
        onUpload={() => undefined}
        onGenerate={() => undefined}
        onReset={() => undefined}
        variant="workspace-inline"
      />,
    );

    const buttons = Array.from(rendered.container.querySelectorAll<HTMLButtonElement>('.image-composer-actions button'));
    const generateIcon = buttons[0]?.querySelector('svg');
    const resetIcon = buttons[1]?.querySelector('svg');

    expect(generateIcon?.getAttribute('fill')).toBe('currentColor');
    expect(resetIcon?.getAttribute('fill')).toBe('none');
    expect(resetIcon?.getAttribute('stroke')).toBe('currentColor');
    expect(resetIcon?.getAttribute('stroke-linecap')).toBe('round');

    rendered.unmount();
  });
});
