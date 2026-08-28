import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { AiMessagePartRenderer } from './views/AiMessagePartRenderer';

describe('AI workspace view boundaries', () => {
  it('renders an understandable fallback for an unknown message part', () => {
    const rendered = render(<AiMessagePartRenderer part={{ type: 'future_part', id: 'part-1' }} />);
    expect(rendered.getByText('这条内容暂时无法显示')).toBeTruthy();
  });
});
