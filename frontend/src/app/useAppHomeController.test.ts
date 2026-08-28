import { describe, expect, it, vi } from 'vitest';
import { buildHomeShoppingController } from './useAppHomeController';
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
});
