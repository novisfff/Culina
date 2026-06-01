export function readJsonStorage<T>(key: string, fallback: T, options: { clearOnError?: boolean } = {}): T {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) {
      return fallback;
    }
    return JSON.parse(raw) as T;
  } catch {
    if (options.clearOnError ?? true) {
      localStorage.removeItem(key);
    }
    return fallback;
  }
}

export function writeJsonStorage<T>(key: string, value: T): void {
  localStorage.setItem(key, JSON.stringify(value));
}

export function readStringStorage(key: string, fallback: string): string {
  return localStorage.getItem(key) ?? fallback;
}

export function writeStringStorage(key: string, value: string): void {
  localStorage.setItem(key, value);
}

export function removeStorage(key: string): void {
  localStorage.removeItem(key);
}
