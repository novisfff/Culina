import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildInventoryAlerts, todayKey } from './helpers';
import { createInitialState } from './seed';

afterEach(() => {
  vi.useRealTimers();
});

describe('todayKey', () => {
  it('formats the current local calendar day', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 0, 1, 1, 30, 0));

    expect(todayKey()).toBe('2026-01-01');
  });
});

describe('buildInventoryAlerts', () => {
  it('returns low stock and expiry alerts from seeded demo data', () => {
    const state = createInitialState();
    const alerts = buildInventoryAlerts(state.inventoryItems, state.ingredients);

    expect(alerts.length).toBeGreaterThan(0);
    expect(alerts.some((alert) => alert.title.includes('库存偏低'))).toBe(true);
    expect(alerts.some((alert) => alert.title.includes('即将到期'))).toBe(true);
  });
});
