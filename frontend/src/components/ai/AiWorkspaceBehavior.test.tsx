import { describe, expect, it } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import { AiMessagePartRenderer } from './views/AiMessagePartRenderer';

describe('AI workspace view boundaries', () => {
  it('renders an understandable fallback for an unknown message part', () => {
    const rendered = render(<AiMessagePartRenderer part={{ type: 'future_part', id: 'part-1' }} />);
    expect(rendered.getByText('这条内容暂时无法显示')).toBeTruthy();
  });

  it('loads markdown only for a markdown part', async () => {
    const rendered = render(<AiMessagePartRenderer part={{ type: 'markdown', id: 'part-2', text: '**内容**' }} />);
    await waitFor(() => expect(rendered.container.querySelector('.ai-message-markdown')).toBeTruthy());
    expect(rendered.container.textContent).toContain('内容');
  });
});
