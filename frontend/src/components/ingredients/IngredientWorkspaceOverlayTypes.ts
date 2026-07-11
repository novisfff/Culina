import type { FormEvent } from 'react';
import type {
  CorrectInventoryExpiryDateRequest,
  DisposeExpiredInventoryRequest,
  Food,
  Ingredient,
  SnoozeExpiryAlertsRequest,
  VersionedInventoryItemRef,
} from '../../api/types';
import type { ExpiryInventoryActionGroup } from '../../features/inventory/inventoryActionModel';
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

export type InventoryActionConflictState = 'none' | 'review_again';

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
  inventoryActionIngredientId: string | null;
  inventoryActionGroup: ExpiryInventoryActionGroup | null;
  inventoryActionReferenceDate: string;
  inventoryActionBusy?: boolean;
  inventoryActionError?: string | null;
  inventoryActionConflict?: InventoryActionConflictState;
  ingredients: Ingredient[];
  foods: Food[];
  ingredientSummaries: IngredientSummaryViewModel[];
  quickRestockIngredients: Ingredient[];
  submitInventory: (event: FormEvent<HTMLFormElement>) => Promise<void>;
  submitConsume: (event: FormEvent<HTMLFormElement>) => Promise<void>;
  submitShopping: (event: FormEvent<HTMLFormElement>) => Promise<void>;
  disposeSelectedInventoryBatches: (items: VersionedInventoryItemRef[]) => Promise<void>;
  snoozeSelectedInventoryAlerts: (args: {
    action: SnoozeExpiryAlertsRequest['action'];
    items: VersionedInventoryItemRef[];
    snoozedUntil: string;
  }) => Promise<void>;
  correctSelectedInventoryExpiryDate: (args: {
    inventoryItemId: string;
    expectedRowVersion: number;
    expiryDate: string;
  }) => Promise<void>;
  pendingShoppingToComplete: PendingShoppingCompletion | null;
  isCreatingInventory?: boolean;
  isConsumingInventory?: boolean;
  isCreatingShopping?: boolean;
};
