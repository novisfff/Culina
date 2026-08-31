export type InventoryReconciliationScope =
  | 'suggested'
  | 'refrigerated'
  | 'frozen'
  | 'room_temperature'
  | 'all';

const SCOPE_STORAGE_LOCATION: Record<Exclude<InventoryReconciliationScope, 'suggested' | 'all'>, string> = {
  refrigerated: '冷藏',
  frozen: '冷冻',
  room_temperature: '常温',
};

export function storageLocationForScope(scope: InventoryReconciliationScope): string | null {
  if (scope === 'suggested' || scope === 'all') return null;
  return SCOPE_STORAGE_LOCATION[scope];
}
