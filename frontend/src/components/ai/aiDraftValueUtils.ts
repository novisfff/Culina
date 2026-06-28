export type DraftRecord = Record<string, unknown>;

export function isDraftRecord(value: unknown): value is DraftRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function asDraftArray(value: unknown): DraftRecord[] {
  return Array.isArray(value) ? value.filter(isDraftRecord) : [];
}

export function asText(value: unknown, fallback = '') {
  return typeof value === 'string' ? value : fallback;
}

export function asNumber(value: unknown, fallback = 1) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}
