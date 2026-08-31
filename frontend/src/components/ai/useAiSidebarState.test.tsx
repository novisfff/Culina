import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { resolveInitialAiSidebarCollapsed, useAiSidebarState } from './useAiSidebarState';

describe('AI sidebar state', () => {
  beforeEach(() => {
    localStorage.clear();
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1440 });
  });

  it('persists desktop preference', () => {
    const { result } = renderHook(() => useAiSidebarState());
    act(() => result.current.toggleSidebar(true));
    expect(result.current.isSidebarCollapsed).toBe(true);
    expect(localStorage.getItem('ai_sidebar_collapsed')).toBe('true');
  });

  it('forces tablet sidebar closed without overwriting desktop preference', () => {
    localStorage.setItem('ai_sidebar_collapsed', 'false');
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1024 });
    expect(resolveInitialAiSidebarCollapsed()).toBe(true);
    const { result } = renderHook(() => useAiSidebarState());
    act(() => result.current.toggleSidebar(false));
    expect(localStorage.getItem('ai_sidebar_collapsed')).toBe('false');
  });
});
