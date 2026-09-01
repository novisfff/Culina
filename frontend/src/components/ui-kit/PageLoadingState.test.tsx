// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { PageLoadingState } from './PageLoadingState';

describe('PageLoadingState', () => {
  it('exposes a reusable, labelled busy page state', () => {
    render(<PageLoadingState title="家庭 AI 服务" description="正在读取当前家庭设置。" />);

    expect(screen.getByRole('main', { name: '家庭 AI 服务' })).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByRole('heading', { name: '家庭 AI 服务' })).toBeVisible();
    expect(screen.getByRole('status')).toHaveTextContent('正在读取当前家庭设置。');
    expect(screen.getByRole('progressbar', { name: '正在加载家庭 AI 服务' })).toBeInTheDocument();
  });

  it('supports an optional context label without changing the page title', () => {
    render(<PageLoadingState title="首页" description="页面内容正在加载，请稍候。" eyebrow="正在准备" />);

    expect(screen.getByText('正在准备')).toBeVisible();
    expect(screen.getByRole('heading', { name: '首页' })).toBeVisible();
  });
});
