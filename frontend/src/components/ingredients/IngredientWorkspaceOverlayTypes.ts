import type { FormEvent } from 'react';
import type { Food, Ingredient } from '../../api/types';
import type { IngredientOverlayMode, IngredientSummaryViewModel } from './workspaceModel';
import type {
  ConsumeDialogFormState,
  InventoryDrawerFormState,
  ShoppingDialogFormState,
} from './ingredientWorkspaceForms';

export type PendingShoppingCompletion = {
  itemId: string;
  title: string;
};

export type OverlayLayerProps = {
  overlayMode: IngredientOverlayMode;
  closeOverlay: () => void;
  inventoryForm: InventoryDrawerFormState;
  setInventoryForm: (next: InventoryDrawerFormState) => void;
  inventoryAdvancedOpen: boolean;
  setInventoryAdvancedOpen: (next: boolean) => void;
  consumeForm: ConsumeDialogFormState;
  setConsumeForm: (next: ConsumeDialogFormState) => void;
  shoppingForm: ShoppingDialogFormState;
  setShoppingForm: (next: ShoppingDialogFormState) => void;
  destroyExpiredIngredientId: string | null;
  ingredients: Ingredient[];
  foods: Food[];
  ingredientSummaries: IngredientSummaryViewModel[];
  quickRestockIngredients: Ingredient[];
  submitInventory: (event: FormEvent<HTMLFormElement>) => Promise<void>;
  submitConsume: (event: FormEvent<HTMLFormElement>) => Promise<void>;
  submitShopping: (event: FormEvent<HTMLFormElement>) => Promise<void>;
  submitDestroyExpired: (event: FormEvent<HTMLFormElement>) => Promise<void>;
  pendingShoppingToComplete: PendingShoppingCompletion | null;
  isCreatingInventory?: boolean;
  isConsumingInventory?: boolean;
  isDisposingExpiredInventory?: boolean;
  isCreatingShopping?: boolean;
};
