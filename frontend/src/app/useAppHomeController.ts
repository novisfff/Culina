import { useMemo, type FormEvent } from 'react';
import type { Food } from '../api/types/food';
import type { Ingredient } from '../api/types/inventory';
import { buildShoppingForm, type ShoppingDialogFormState } from '../features/inventory/shoppingFormModel';
import { resolveShoppingFormSubmission } from '../components/ingredients/shoppingFormSubmission';

type Notice = { tone: 'warning' | 'danger' | 'success'; title: string; message: string };
type Args = { ingredients: Ingredient[]; foods: Food[]; form: ShoppingDialogFormState; setOpen: (open: boolean) => void; setForm: (form: ShoppingDialogFormState) => void; createShopping: (payload: unknown) => Promise<unknown> };

export function buildHomeShoppingController(args: Args) {
  return {
    openForIngredient(ingredientId: string, showNotice: (notice: Notice) => void) {
      const ingredient = args.ingredients.find((item) => item.id === ingredientId);
      if (!ingredient) { showNotice({ tone: 'warning', title: '食材暂不可用', message: '没有找到对应食材，请刷新后再试。' }); return; }
      args.setForm(buildShoppingForm(ingredient, '库存不足'));
      args.setOpen(true);
    },
    async submit(event: FormEvent<HTMLFormElement>, showNotice: (notice: Notice) => void) {
      event.preventDefault();
      const resolution = resolveShoppingFormSubmission({ form: args.form, ingredients: args.ingredients, foods: args.foods });
      if (!resolution.ok) { showNotice({ tone: 'warning', title: resolution.title, message: resolution.message }); return; }
      try { await args.createShopping(resolution.payload); args.setForm(buildShoppingForm()); args.setOpen(false); }
      catch (reason) { showNotice({ tone: 'danger', title: '加入采购清单失败', message: reason instanceof Error && reason.message.trim() ? reason.message : '加入采购清单失败' }); }
    },
  };
}

/** React boundary for Home's shopping side effects; avoids rebuilding handlers on every render. */
export function useAppHomeController(args: Args) {
  return useMemo(() => buildHomeShoppingController(args), [
    args.ingredients,
    args.foods,
    args.form,
    args.setOpen,
    args.setForm,
    args.createShopping,
  ]);
}
