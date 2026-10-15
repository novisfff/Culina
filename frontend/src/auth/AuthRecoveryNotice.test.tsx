import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthRecoveryNotice } from './AuthRecoveryNotice';

const error = '暂时无法验证登录状态，请检查网络后重试。';

afterEach(cleanup);

describe('AuthRecoveryNotice', () => {
  it('offers retry outside the workspace and restores focus when dismissed', () => {
    const editor = document.createElement('textarea');
    document.body.append(editor);
    editor.focus();
    const onRetry = vi.fn();
    try {
      const { container } = render(<AuthRecoveryNotice error={error} busy={false} onRetry={onRetry} />);
      const dialog = screen.getByRole('dialog', { name: '登录状态暂未更新' });
      expect(container).toBeEmptyDOMElement();
      expect(dialog).toHaveTextContent(error);
      fireEvent.click(within(dialog).getByRole('button', { name: '重试连接' }));
      expect(onRetry).toHaveBeenCalledOnce();

      fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      expect(editor).toHaveFocus();
      expect(editor).not.toHaveAttribute('inert');
    } finally {
      cleanup();
      editor.remove();
    }
  });

  it('keeps retry and dismissal disabled while recovering, then permits another attempt', () => {
    const onRetry = vi.fn();
    const view = render(<AuthRecoveryNotice error={error} busy onRetry={onRetry} />);
    const dialog = screen.getByRole('dialog', { name: '登录状态暂未更新' });
    const retry = within(dialog).getByRole('button', { name: '正在重试…' });
    expect(retry).toBeDisabled();
    expect(retry).toHaveAttribute('aria-busy', 'true');
    within(dialog).getAllByRole('button', { name: '暂时关闭' }).forEach((button) => {
      expect(button).toBeDisabled();
      fireEvent.click(button);
    });
    fireEvent.click(retry);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(dialog).toBeInTheDocument();
    expect(onRetry).not.toHaveBeenCalled();

    view.rerender(<AuthRecoveryNotice error={error} busy={false} onRetry={onRetry} />);
    fireEvent.click(within(dialog).getByRole('button', { name: '重试连接' }));
    expect(onRetry).toHaveBeenCalledOnce();
    fireEvent.click(within(dialog).getAllByRole('button', { name: '暂时关闭' })[0]);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});
