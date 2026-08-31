import type { Food, IngredientInventoryState, InventoryConfirmationStatus, InventoryItem } from '../../api/types';
import { hoursBetweenInstants } from '../../lib/date';
import { getInventoryRemainingQuantity } from '../../lib/ingredientUnits';
import type { InventoryConfirmationTone } from './workspaceTypes';

/** Fixed re-confirm intervals from the approved design. */
export const FOOD_STALE_AFTER_DAYS = 7;
export const REFRIGERATED_INGREDIENT_STALE_AFTER_DAYS = 14;
export const FROZEN_INGREDIENT_STALE_AFTER_DAYS = 30;
export const ROOM_TEMPERATURE_INGREDIENT_STALE_AFTER_DAYS = 30;
export const PRESENCE_INGREDIENT_STALE_AFTER_DAYS = 30;

export const CONFIRMATION_STATUS_LABELS: Record<InventoryConfirmationStatus, string> = {
  never_confirmed: '未确认',
  current: '刚确认过',
  stale: '建议再确认',
};

export const CONFIRMATION_STATUS_TONES: Record<InventoryConfirmationStatus, InventoryConfirmationTone> = {
  never_confirmed: 'neutral',
  current: 'current',
  stale: 'stale',
};

export function confirmationStatusLabel(status: InventoryConfirmationStatus): string {
  return CONFIRMATION_STATUS_LABELS[status];
}

export function confirmationStatusTone(status: InventoryConfirmationStatus): InventoryConfirmationTone {
  return CONFIRMATION_STATUS_TONES[status];
}

export function staleAfterDaysForStorageLocation(storageLocation: string | null | undefined): number {
  const label = (storageLocation || '').trim();
  if (label === '冷藏') return REFRIGERATED_INGREDIENT_STALE_AFTER_DAYS;
  if (label === '冷冻') return FROZEN_INGREDIENT_STALE_AFTER_DAYS;
  if (label === '常温') return ROOM_TEMPERATURE_INGREDIENT_STALE_AFTER_DAYS;
  return ROOM_TEMPERATURE_INGREDIENT_STALE_AFTER_DAYS;
}

/** Pure confirmation freshness from last_confirmed_at only. */
export function confirmationStatusFromLastConfirmedAt(
  lastConfirmedAt: string | null | undefined,
  args: { referenceDate: string; staleAfterDays: number },
): InventoryConfirmationStatus {
  if (!lastConfirmedAt) return 'never_confirmed';
  const referenceInstant = args.referenceDate.includes('T')
    ? args.referenceDate
    : `${args.referenceDate.slice(0, 10)}T12:00:00.000Z`;
  const ageHours = hoursBetweenInstants(referenceInstant, lastConfirmedAt);
  if (!Number.isFinite(ageHours)) return 'never_confirmed';
  return ageHours > args.staleAfterDays * 24 ? 'stale' : 'current';
}

export function aggregateConfirmationStatus(statuses: InventoryConfirmationStatus[]): InventoryConfirmationStatus {
  if (statuses.length === 0) return 'never_confirmed';
  if (statuses.some((status) => status === 'never_confirmed')) return 'never_confirmed';
  if (statuses.some((status) => status === 'stale')) return 'stale';
  return 'current';
}

export function earliestConfirmationAt(values: Array<string | null | undefined>): string | null {
  const present = values.filter((value): value is string => Boolean(value));
  if (present.length === 0) return null;
  return present.slice().sort((left, right) => left.localeCompare(right))[0] ?? null;
}

type ConfirmationResult = {
  confirmationStatus: InventoryConfirmationStatus;
  confirmationLabel: string;
  confirmationTone: InventoryConfirmationTone;
  lastConfirmedAt: string | null;
};

function resolveConfirmationResult(
  statuses: InventoryConfirmationStatus[],
  lastConfirmedAt: string | null,
): ConfirmationResult {
  const confirmationStatus = aggregateConfirmationStatus(statuses);
  return {
    confirmationStatus,
    confirmationLabel: confirmationStatusLabel(confirmationStatus),
    confirmationTone: confirmationStatusTone(confirmationStatus),
    lastConfirmedAt,
  };
}

export function buildExactIngredientConfirmation(args: {
  batches: Array<Pick<InventoryItem, 'last_confirmed_at' | 'storage_location' | 'remaining_quantity' | 'quantity' | 'consumed_quantity' | 'disposed_quantity'>>;
  referenceDate: string;
  fallbackStorage?: string | null;
}): ConfirmationResult {
  const remaining = args.batches.filter((batch) => getInventoryRemainingQuantity(batch as InventoryItem) > 0);
  if (remaining.length === 0) return resolveConfirmationResult([], null);
  return resolveConfirmationResult(
    remaining.map((batch) => confirmationStatusFromLastConfirmedAt(batch.last_confirmed_at, {
      referenceDate: args.referenceDate,
      staleAfterDays: staleAfterDaysForStorageLocation(batch.storage_location || args.fallbackStorage),
    })),
    earliestConfirmationAt(remaining.map((batch) => batch.last_confirmed_at)),
  );
}

export function buildPresenceIngredientConfirmation(args: {
  state: IngredientInventoryState | null | undefined;
  referenceDate: string;
}): ConfirmationResult {
  const status = confirmationStatusFromLastConfirmedAt(args.state?.last_confirmed_at, {
    referenceDate: args.referenceDate,
    staleAfterDays: PRESENCE_INGREDIENT_STALE_AFTER_DAYS,
  });
  return resolveConfirmationResult([status], args.state?.last_confirmed_at ?? null);
}

export function buildFoodConfirmation(args: {
  food: Pick<Food, 'inventory_last_confirmed_at' | 'storage_location'>;
  referenceDate: string;
}): ConfirmationResult {
  const status = confirmationStatusFromLastConfirmedAt(args.food.inventory_last_confirmed_at, {
    referenceDate: args.referenceDate,
    staleAfterDays: FOOD_STALE_AFTER_DAYS,
  });
  return resolveConfirmationResult([status], args.food.inventory_last_confirmed_at ?? null);
}
