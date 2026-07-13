import { act, render, renderHook, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { readStringStorage, writeStringStorage } from '../lib/storage';
import { useAppNavigationState } from './useAppNavigationState';

beforeEach(() => {
  localStorage.clear();
});

describe('useAppNavigationState', () => {
  it('migrates a legacy recipe tab but persists no task', () => {
    writeStringStorage('culina-active-tab', 'recipes');
    const { result } = renderHook(() => useAppNavigationState());
    expect(result.current.state.eat).toMatchObject({ baseView: 'discover', discoverSection: 'selfMade', task: null });
    act(() => result.current.navigate({ workspace: 'eat', view: 'recipe', recipeId: 'recipe-1' }));
    expect(JSON.parse(readStringStorage('culina-navigation-v2', '{}'))).toEqual({
      version: 2,
      primaryTab: 'eat',
      eatBaseView: 'discover',
      discoverSection: 'selfMade',
    });
  });

  function NavigationFocusHarness({ detachTriggerOnOpen = false }: { detachTriggerOnOpen?: boolean }) {
    const navigation = useAppNavigationState();
    return (
      <>
        {!detachTriggerOnOpen || !navigation.state.eat.task ? (
          <button
            type="button"
            onClick={(event) => navigation.navigate(
              { workspace: 'eat', view: 'food', foodId: 'food-1' },
              event.currentTarget,
            )}
          >
            打开家常菜
          </button>
        ) : null}
        <section
          ref={navigation.registerBaseViewFocusTarget}
          tabIndex={-1}
          aria-label="发现列表"
        >
          发现
        </section>
        {navigation.state.eat.task ? (
          <section role="dialog" aria-label="家常菜任务">
            <h2 ref={navigation.registerTaskHeading} tabIndex={-1}>家常菜详情</h2>
            <button type="button" onClick={navigation.closeTask}>关闭任务</button>
          </section>
        ) : null}
      </>
    );
  }

  it('focuses the committed task heading and restores the trigger after close', async () => {
    const user = userEvent.setup();
    render(<NavigationFocusHarness />);
    const trigger = screen.getByRole('button', { name: '打开家常菜' });

    await user.click(trigger);
    expect(screen.getByRole('heading', { name: '家常菜详情' })).toHaveFocus();

    await user.click(screen.getByRole('button', { name: '关闭任务' }));
    expect(trigger).toHaveFocus();
  });

  it('restores the base view when an overlay trigger has unmounted', async () => {
    const user = userEvent.setup();
    render(<NavigationFocusHarness detachTriggerOnOpen />);
    await user.click(screen.getByRole('button', { name: '打开家常菜' }));
    await user.click(screen.getByRole('button', { name: '关闭任务' }));
    expect(screen.getByRole('region', { name: '发现列表' })).toHaveFocus();
  });
});
