import { useMemo, useState } from 'react';
import type { Ingredient, RecipeIngredient, ShoppingListItem } from '../../api/types';
import type { RecipeCardViewModel } from './workspaceModel';
import {
  buildCustomShoppingDraft,
  buildShoppingDraftFromRecipeIngredient,
  buildShoppingDraftsFromShortages,
  buildShoppingPayloadsFromDrafts,
  formatShoppingQuantity,
  resolveErrorMessage,
  resolveIngredientImageUrl,
  type RecipeNotice,
  type RecipeShoppingCustomForm,
  type RecipeShoppingDraftItem,
  type RecipeShoppingIngredientOption,
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
  }) => Promise<ShoppingListItem>;
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

  const shoppingIngredientOptions = useMemo<RecipeShoppingIngredientOption[]>(
    () =>
      args.ingredients.map((ingredient) => ({
        id: ingredient.id,
        name: ingredient.name,
        unit: ingredient.default_unit || '个',
        imageUrl: resolveIngredientImageUrl(ingredient, ingredient.name),
        category: ingredient.category,
        quantityMode: ingredient.quantity_tracking_mode ?? 'track_quantity',
      })),
    [args.ingredients]
  );

  const visibleShoppingIngredientOptions = useMemo(() => {
    const keyword = shoppingCustomForm.title.trim().toLowerCase();
    if (!keyword) return shoppingIngredientOptions.slice(0, 8);
    return shoppingIngredientOptions
      .filter((item) => `${item.name} ${item.category}`.toLowerCase().includes(keyword))
      .slice(0, 8);
  }, [shoppingCustomForm.title, shoppingIngredientOptions]);

  function openShoppingDialog(card: RecipeCardViewModel, closeCookDialog: () => void) {
    closeCookDialog();
    setShoppingDialogCard(card);
    setShoppingDrafts(buildShoppingDraftsFromShortages(card));
    setShoppingCustomForm({ ingredientId: null, title: '', quantity: '1', unit: '个' });
  }

  function closeShoppingDialog() {
    setShoppingDialogCard(null);
    setShoppingDrafts([]);
    setShoppingCustomForm({ ingredientId: null, title: '', quantity: '1', unit: '个' });
  }

  function updateShoppingDraft(
    itemId: string,
    patch: Partial<Pick<RecipeShoppingDraftItem, 'title' | 'quantity' | 'unit' | 'reason' | 'quantityMode' | 'displayLabel' | 'ingredientId'>>
  ) {
    setShoppingDrafts((current) => current.map((item) => (item.id === itemId ? { ...item, ...patch } : item)));
  }

  function adjustShoppingDraftQuantity(itemId: string, delta: number) {
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
    setShoppingDrafts((current) => current.filter((item) => item.id !== itemId));
  }

  function addRecipeIngredientToShoppingDraft(item: RecipeIngredient) {
    if (!shoppingDialogCard) return;
    if (!item.ingredient_id) {
      args.showRecipeNotice({ tone: 'warning', title: '先创建食材档案', message: '这个菜谱食材还没有绑定食材档案，先建档后才能加入采购清单。' });
      return;
    }
    const draft = buildShoppingDraftFromRecipeIngredient(shoppingDialogCard.recipe.title, item);
    setShoppingDrafts((current) => {
      if (current.some((entry) => entry.recipeIngredientId === item.id)) return current;
      return [...current, draft];
    });
  }

  function addCustomShoppingDraft() {
    if (!shoppingDialogCard) return;
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
    const currentQuantity = Number(shoppingCustomForm.quantity);
    const nextQuantity = Math.max(0.01, (Number.isFinite(currentQuantity) ? currentQuantity : 1) + delta);
    setShoppingCustomForm({ ...shoppingCustomForm, quantity: formatShoppingQuantity(nextQuantity) });
  }

  function selectShoppingIngredientOption(option: RecipeShoppingIngredientOption) {
    setShoppingCustomForm((current) => ({
      ...current,
      ingredientId: option.id,
      title: option.name,
      unit: option.unit,
    }));
    setIsShoppingIngredientPickerOpen(false);
  }

  async function submitShoppingDrafts() {
    const payloads = buildShoppingPayloadsFromDrafts(shoppingDrafts);
    if (payloads.length === 0) {
      args.showRecipeNotice({ tone: 'warning', title: '没有可加入项', message: '请至少保留一个有效采购项。' });
      return;
    }
    try {
      await Promise.all(payloads.map((payload) => args.createShoppingItem(payload)));
      closeShoppingDialog();
      args.showRecipeNotice({ tone: 'success', title: '已加入采购清单', message: `${payloads.length} 项食材已放进采购清单。` });
    } catch (reason) {
      args.showRecipeNotice({ tone: 'danger', title: '加入采购失败', message: resolveErrorMessage(reason, '加入采购失败') });
    }
  }

  return {
    shoppingDialogCard,
    shoppingDrafts,
    shoppingCustomForm,
    setShoppingCustomForm,
    isShoppingIngredientPickerOpen,
    setIsShoppingIngredientPickerOpen,
    shoppingIngredientOptions,
    visibleShoppingIngredientOptions,
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
