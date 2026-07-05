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

export type EditableDraftNumber = number | '';

export function draftNumberInputValue(value: unknown, fallback: EditableDraftNumber = ''): EditableDraftNumber {
  if (value === '') return '';
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return numeric;
  }
  return fallback;
}

export function draftNumberFromInput(value: string): EditableDraftNumber {
  return draftNumberInputValue(value);
}

export function nullableDraftNumberFromInput(value: string) {
  const numeric = draftNumberFromInput(value);
  return typeof numeric === 'number' ? numeric : null;
}
