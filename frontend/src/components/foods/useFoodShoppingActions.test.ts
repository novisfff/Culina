import { describe, expect, it, vi } from 'vitest';
import { createFoodShoppingSubmit } from './useFoodShoppingActions';

describe('createFoodShoppingSubmit', () => {
  it('does not call a mutation when the quantity is invalid', async () => {
    const setError = vi.fn();
    const createShoppingItem = vi.fn();
    const submit = createFoodShoppingSubmit({
      dialog: { existingItem: null, draft: { foodId: 'food-1', title: '米饭', quantity: '0', unit: '份', reason: '补充成品库存' } },
      isSubmitting: false,
      setDialog: vi.fn(), setSubmitting: vi.fn(), setError,
      createShoppingItem, updateShoppingItem: vi.fn(), showNotice: vi.fn(),
    });
    await submit();
    expect(createShoppingItem).not.toHaveBeenCalled();
    expect(setError).toHaveBeenCalled();
  });
});
