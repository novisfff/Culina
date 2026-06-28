import { describe, expect, it } from 'vitest';
import { asDraftArray, asNumber, asText, isDraftRecord } from './aiDraftValueUtils';

describe('aiDraftValueUtils', () => {
  it('narrows draft records and filters arrays', () => {
    const record = { name: '番茄' };

    expect(isDraftRecord(record)).toBe(true);
    expect(isDraftRecord(null)).toBe(false);
    expect(isDraftRecord(['番茄'])).toBe(false);
    expect(asDraftArray([record, null, ['嵌套数组'], '文本', { quantity: 2 }])).toEqual([
      record,
      { quantity: 2 },
    ]);
    expect(asDraftArray({ name: '番茄' })).toEqual([]);
  });

  it('keeps text and finite numeric values only', () => {
    expect(asText('冷藏')).toBe('冷藏');
    expect(asText(123, '默认')).toBe('默认');
    expect(asNumber(2.5)).toBe(2.5);
    expect(asNumber(Number.NaN, 0)).toBe(0);
    expect(asNumber('2', 1)).toBe(1);
  });
});
