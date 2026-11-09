import { useRef, useState } from 'react';
import type { Ingredient, RecipeIngredient, ShoppingListItem } from '../../api/types/recipe';
import type { RecipeCardViewModel } from './workspaceModel';
import {
  buildCustomShoppingDraft,
  buildShoppingDraftFromRecipeIngredient,
  buildShoppingDraftsFromShortages,
  buildShoppingPayloadsFromDrafts,
  formatShoppingQuantity,
  resolveErrorMessage,
  type RecipeNotice,
  type RecipeShoppingCustomForm,
  type RecipeShoppingDraftItem,
} from './RecipeWorkspaceModel';

type UseRecipeShoppingStateArgs = {
  ingredients: Ingredient[];
  createShoppingItem: (payload: {
    title: string;
    quantity?: number | null;
    unit?: string | null;
    ingredient_id: string;
    quantity_mode?: ShoppingListItem['quantity_mode'];
    display_label?: string | null;
    reason: string;
  }) => Promise<unknown>;
  showRecipeNotice: (notice: RecipeNotice) => void;
};

export function useRecipeShoppingState(args: UseRecipeShoppingStateArgs) {
  const [shoppingDialogCard, setShoppingDialogCard] = useState<RecipeCardViewModel | null>(null);
  const [shoppingDrafts, setShoppingDrafts] = useState<RecipeShoppingDraftItem[]>([]);
  const [shoppingCustomForm, setShoppingCustomForm] = useState<RecipeShoppingCustomForm>({
    ingredientId: null,
    title: '',
    quantity: '1',
    unit: '个',
  });
  const [isShoppingIngredientPickerOpen, setIsShoppingIngredientPickerOpen] = useState(false);
  const [isSubmittingShopping, setIsSubmittingShopping] = useState(false);
  const [shoppingSubmitError, setShoppingSubmitError] = useState<string | null>(null);
  const submittingRef = useRef(false);

  function openShoppingDialog(
    card: RecipeCardViewModel,
    closeCookDialog: () => void,
    mode: 'shortages' | 'all' = 'shortages',
  ) {
    if (submittingRef.current) return;
    closeCookDialog();
    setShoppingSubmitError(null);
    setShoppingDialogCard(card);
    setShoppingDrafts(
      mode === 'all'
        ? card.recipe.ingredient_items
            .filter((item) => Boolean(item.ingredient_id))
            .map((item) => buildShoppingDraftFromRecipeIngredient(card.recipe.title, item))
        : buildShoppingDraftsFromShortages(card),
    );
    setShoppingCustomForm({ ingredientId: null, title: '', quantity: '1', unit: '个' });
  }

  function closeShoppingDialog() {
    if (submittingRef.current) return;
    resetShoppingDialog();
  }

  function resetShoppingDialog() {
    setShoppingDialogCard(null);
    setShoppingDrafts([]);
    setShoppingCustomForm({ ingredientId: null, title: '', quantity: '1', unit: '个' });
    setIsShoppingIngredientPickerOpen(false);
    setShoppingSubmitError(null);
  }

  function updateShoppingDraft(
    itemId: string,
    patch: Partial<Pick<RecipeShoppingDraftItem, 'title' | 'quantity' | 'unit' | 'reason' | 'quantityMode' | 'displayLabel' | 'ingredientId'>>
  ) {
    if (submittingRef.current) return;
    setShoppingDrafts((current) => current.map((item) => (item.id === itemId ? { ...item, ...patch } : item)));
  }

  function adjustShoppingDraftQuantity(itemId: string, delta: number) {
    if (submittingRef.current) return;
    setShoppingDrafts((current) =>
      current.map((item) => {
        if (item.id !== itemId) return item;
        const currentQuantity = Number(item.quantity);
        const nextQuantity = Math.max(0.01, (Number.isFinite(currentQuantity) ? currentQuantity : 1) + delta);
        return { ...item, quantity: formatShoppingQuantity(nextQuantity) };
      })
    );
  }

  function removeShoppingDraft(itemId: string) {
    if (submittingRef.current) return;
    setShoppingDrafts((current) => current.filter((item) => item.id !== itemId));
  }

  function addRecipeIngredientToShoppingDraft(item: RecipeIngredient) {
    if (!shoppingDialogCard || submittingRef.current) return;
    if (!item.ingredient_id) {
      args.showRecipeNotice({ tone: 'warning', title: '先添加食材', message: '这份食材还没有加入食材库，请先添加或选择食材，再加入采购清单。' });
      return;
    }
    const draft = buildShoppingDraftFromRecipeIngredient(shoppingDialogCard.recipe.title, item);
    setShoppingDrafts((current) => {
      if (current.some((entry) => entry.recipeIngredientId === item.id)) return current;
      return [...current, draft];
    });
  }

  function addCustomShoppingDraft() {
    if (!shoppingDialogCard || submittingRef.current) return;
    const draft = buildCustomShoppingDraft(shoppingDialogCard.recipe.title, shoppingCustomForm);
    if (!draft) {
      args.showRecipeNotice({ tone: 'warning', title: '还差一点', message: '请先从食材库选择食材，并填写大于 0 的数量。' });
      return;
    }
    setShoppingDrafts((current) => [...current, draft]);
    setShoppingCustomForm({ ingredientId: null, title: '', quantity: '1', unit: shoppingCustomForm.unit.trim() || '个' });
    setIsShoppingIngredientPickerOpen(false);
  }

  function adjustCustomShoppingQuantity(delta: number) {
    if (submittingRef.current) return;
    const currentQuantity = Number(shoppingCustomForm.quantity);
    const nextQuantity = Math.max(0.01, (Number.isFinite(currentQuantity) ? currentQuantity : 1) + delta);
    setShoppingCustomForm({ ...shoppingCustomForm, quantity: formatShoppingQuantity(nextQuantity) });
  }

  function selectShoppingIngredientOption(ingredient: Ingredient) {
    if (submittingRef.current) return;
    setShoppingCustomForm((current) => ({
      ...current,
      ingredientId: ingredient.id,
      title: ingredient.name,
      unit: ingredient.default_unit || '个',
    }));
    setIsShoppingIngredientPickerOpen(false);
  }

  async function submitShoppingDrafts() {
    if (submittingRef.current) return;
    const submissions = shoppingDrafts.flatMap((draft) =>
      buildShoppingPayloadsFromDrafts([draft]).map((payload) => ({ id: draft.id, payload })),
    );
    if (submissions.length === 0) {
      setShoppingSubmitError('请至少保留一个有效的待买内容。');
      args.showRecipeNotice({ tone: 'warning', title: '没有可加入的内容', message: '请至少保留一个有效的待买内容。' });
      return;
    }
    submittingRef.current = true;
    setIsSubmittingShopping(true);
    setShoppingSubmitError(null);
    try {
      const results = await Promise.allSettled(submissions.map(async ({ payload }) => args.createShoppingItem(payload)));
      const successfulIds = new Set(submissions.filter((_, index) => results[index].status === 'fulfilled').map(({ id }) => id));
      const remainingDrafts = shoppingDrafts.filter((draft) => !successfulIds.has(draft.id));
      setShoppingDrafts(remainingDrafts);
      const failures = results.filter((result) => result.status === 'rejected');
      if (failures.length > 0) {
        const detail = resolveErrorMessage(failures[0].reason, '暂时无法加入采购清单');
        const message = `已加入 ${successfulIds.size} 项，${failures.length} 项未成功。${detail}，请重试剩余项目。`;
        setShoppingSubmitError(message);
        args.showRecipeNotice({ tone: 'danger', title: '仍有内容未加入采购清单', message });
      } else if (remainingDrafts.length > 0) {
        setShoppingSubmitError(`已加入 ${successfulIds.size} 项，另有 ${remainingDrafts.length} 项内容不完整，请补全或删除。`);
      } else {
        resetShoppingDialog();
        args.showRecipeNotice({ tone: 'success', title: '已加入采购清单', message: `${successfulIds.size} 项食材已放进采购清单。` });
      }
    } finally {
      submittingRef.current = false;
      setIsSubmittingShopping(false);
    }
  }

  return {
    shoppingDialogCard,
    shoppingDrafts,
    shoppingCustomForm,
    setShoppingCustomForm: (form: RecipeShoppingCustomForm) => {
      if (!submittingRef.current) setShoppingCustomForm(form);
    },
    isShoppingIngredientPickerOpen,
    setIsShoppingIngredientPickerOpen: (open: boolean) => {
      if (!submittingRef.current) setIsShoppingIngredientPickerOpen(open);
    },
    isSubmittingShopping,
    shoppingSubmitError,
    openShoppingDialog,
    closeShoppingDialog,
    updateShoppingDraft,
    adjustShoppingDraftQuantity,
    removeShoppingDraft,
    addRecipeIngredientToShoppingDraft,
    addCustomShoppingDraft,
    adjustCustomShoppingQuantity,
    selectShoppingIngredientOption,
    submitShoppingDrafts,
  };
}
