import { describe, expect, it } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import { AiMessagePartRenderer } from './views/AiMessagePartRenderer';
import { AiWorkspaceRoute } from './AiWorkspaceRoute';

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

  it('keeps shell errors outside the message content region', () => {
    const rendered = render(<AiWorkspaceRoute error="会话加载失败"><div data-testid="thread">已有消息</div></AiWorkspaceRoute>);
    expect(rendered.getByRole('alert')).toHaveTextContent('会话加载失败');
    expect(rendered.getByTestId('thread')).toHaveTextContent('已有消息');
  });
});
