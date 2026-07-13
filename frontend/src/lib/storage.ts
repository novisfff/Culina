export type StorageLike = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
};

function defaultStorage(): StorageLike {
  return localStorage;
}

export function readJsonStorage<T>(
  key: string,
  fallback: T,
  options: { clearOnError?: boolean; storage?: StorageLike } = {},
): T {
  const storage = options.storage ?? defaultStorage();
  try {
    const raw = storage.getItem(key);
    if (!raw) {
      return fallback;
    }
    return JSON.parse(raw) as T;
  } catch {
    if (options.clearOnError ?? true) {
      storage.removeItem(key);
    }
    return fallback;
  }
}

export function writeJsonStorage<T>(key: string, value: T, storage: StorageLike = defaultStorage()): void {
  storage.setItem(key, JSON.stringify(value));
}

export function readStringStorage(key: string, fallback: string, storage: StorageLike = defaultStorage()): string {
  return storage.getItem(key) ?? fallback;
}

export function writeStringStorage(key: string, value: string, storage: StorageLike = defaultStorage()): void {
  storage.setItem(key, value);
}

export function removeStorage(key: string, storage: StorageLike = defaultStorage()): void {
  storage.removeItem(key);
}

/** Local draft key for inventory reconciliation. Scoped to family + user only. */
export const reconciliationDraftKey = (familyId: string, userId: string) =>
  `culina:inventory-reconciliation-draft:${familyId}:${userId}`;
