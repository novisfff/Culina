import { afterEach, describe, expect, it, vi } from 'vitest';
import { readJsonStorage, readStringStorage, reconciliationDraftKey, removeStorage, writeJsonStorage, writeStringStorage } from './storage';

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

describe('storage helpers', () => {
  it('reads and writes JSON values', () => {
    writeJsonStorage('culina-test-json', { filters: ['蔬菜'], count: 2 });

    expect(readJsonStorage('culina-test-json', { filters: [], count: 0 })).toEqual({
      filters: ['蔬菜'],
      count: 2,
    });
  });

  it('returns fallback and clears invalid JSON by default', () => {
    localStorage.setItem('culina-bad-json', '{bad json');

    expect(readJsonStorage('culina-bad-json', { ok: true })).toEqual({ ok: true });
    expect(localStorage.getItem('culina-bad-json')).toBeNull();
  });

  it('can preserve invalid JSON when clearOnError is disabled', () => {
    localStorage.setItem('culina-preserve-json', '{bad json');

    expect(readJsonStorage('culina-preserve-json', ['fallback'], { clearOnError: false })).toEqual(['fallback']);
    expect(localStorage.getItem('culina-preserve-json')).toBe('{bad json');
  });

  it('falls back when localStorage access throws', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('storage blocked');
    });
    const removeSpy = vi.spyOn(Storage.prototype, 'removeItem');

    expect(readJsonStorage('culina-blocked', { safe: true })).toEqual({ safe: true });
    expect(removeSpy).toHaveBeenCalledWith('culina-blocked');
  });

  it('reads, writes and removes string values', () => {
    expect(readStringStorage('culina-string', '默认')).toBe('默认');

    writeStringStorage('culina-string', '已选择');
    expect(readStringStorage('culina-string', '默认')).toBe('已选择');

    removeStorage('culina-string');
    expect(readStringStorage('culina-string', '默认')).toBe('默认');
  });

  it('builds reconciliation draft keys by family and user', () => {
    expect(reconciliationDraftKey('family-1', 'user-2')).toBe(
      'culina:inventory-reconciliation-draft:family-1:user-2',
    );
  });
});
