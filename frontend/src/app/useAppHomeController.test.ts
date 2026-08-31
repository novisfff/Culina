import { describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { buildHomeShoppingController, useAppHomeShoppingState } from './useAppHomeController';
import { buildShoppingForm } from '../features/inventory/shoppingFormModel';

describe('home controller', () => {
  it('keeps invalid shopping drafts open and reports the validation notice', async () => {
    const showNotice = vi.fn();
    const setOpen = vi.fn();
    const controller = buildHomeShoppingController({ ingredients: [], foods: [], form: buildShoppingForm(), setOpen, setForm: vi.fn(), createShopping: vi.fn() });
    await controller.submit({ preventDefault: vi.fn() } as never, showNotice);
    expect(showNotice).toHaveBeenCalled();
    expect(setOpen).not.toHaveBeenCalledWith(false);
  });

  it('owns dialog open/form state and keeps an invalid draft available', async () => {
    const ingredient = { id: 'ingredient-1', name: '番茄', default_unit: '个' } as never;
    const createShopping = vi.fn();
    const showNotice = vi.fn();
    const { result } = renderHook(() => useAppHomeShoppingState({
      ingredients: [ingredient],
      foods: [],
      createShopping,
    }));

    act(() => result.current.openForIngredient('ingredient-1', showNotice));
    expect(result.current.open).toBe(true);
    expect(result.current.form.title).toBe('番茄');

    act(() => result.current.setForm({ ...result.current.form, quantity: '0' }));
    await act(async () => {
      await result.current.submit({ preventDefault: vi.fn() } as never, showNotice);
    });

    expect(result.current.open).toBe(true);
    expect(result.current.form.quantity).toBe('0');
    expect(createShopping).not.toHaveBeenCalled();
    expect(showNotice).toHaveBeenCalledWith(expect.objectContaining({ title: '待买数量无效' }));
  });
});
