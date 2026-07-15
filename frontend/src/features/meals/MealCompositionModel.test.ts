import { describe, expect, it } from 'vitest';
import {
  createLocalCompositionEntryId,
  mergeMealComposition,
  type CompositionEntry,
} from './MealCompositionModel';

function entry(id: string, overrides: Partial<CompositionEntry> = {}): CompositionEntry {
  return {
    id,
    food_id: 'food-1',
    servings: 1,
    note: '',
    food_name: '番茄炒蛋',
    ...overrides,
  };
}

describe('createLocalCompositionEntryId', () => {
  it('prefixes temporary client ids', () => {
    expect(createLocalCompositionEntryId('abc-123')).toBe('client:abc-123');
    expect(createLocalCompositionEntryId()).toMatch(/^client:[0-9a-f-]{36}$/i);
  });
});

describe('mergeMealComposition', () => {
  it('takes server-only field changes when draft matches base', () => {
    const base = [entry('e1', { servings: 1, note: 'base' })];
    const draft = [entry('e1', { servings: 1, note: 'base' })];
    const server = [entry('e1', { servings: 2, note: 'server' })];

    const result = mergeMealComposition(base, draft, server);

    expect(result.entries).toEqual([entry('e1', { servings: 2, note: 'server' })]);
    expect(result.conflicts).toEqual([]);
  });

  it('takes draft-only field changes when server matches base', () => {
    const base = [entry('e1', { servings: 1, note: 'base' })];
    const draft = [entry('e1', { servings: 3, note: 'draft' })];
    const server = [entry('e1', { servings: 1, note: 'base' })];

    const result = mergeMealComposition(base, draft, server);

    expect(result.entries).toEqual([entry('e1', { servings: 3, note: 'draft' })]);
    expect(result.conflicts).toEqual([]);
  });

  it('accepts same-value changes without conflict', () => {
    const base = [entry('e1', { servings: 1, note: 'base' })];
    const draft = [entry('e1', { servings: 2, note: 'same' })];
    const server = [entry('e1', { servings: 2, note: 'same' })];

    const result = mergeMealComposition(base, draft, server);

    expect(result.entries).toEqual([entry('e1', { servings: 2, note: 'same' })]);
    expect(result.conflicts).toEqual([]);
  });

  it('records divergent same-field changes without auto-selecting a side', () => {
    const base = [entry('e1', { servings: 1, note: 'base', food_id: 'food-1' })];
    const draft = [entry('e1', { servings: 2, note: 'draft', food_id: 'food-2' })];
    const server = [entry('e1', { servings: 3, note: 'server', food_id: 'food-9' })];

    const result = mergeMealComposition(base, draft, server);

    expect(result.conflicts).toEqual(
      expect.arrayContaining([
        {
          entry_key: 'e1',
          field: 'servings',
          base: 1,
          draft: 2,
          server: 3,
        },
        {
          entry_key: 'e1',
          field: 'note',
          base: 'base',
          draft: 'draft',
          server: 'server',
        },
        {
          entry_key: 'e1',
          field: 'food_id',
          base: 'food-1',
          draft: 'food-2',
          server: 'food-9',
        },
      ]),
    );
    expect(result.conflicts).toHaveLength(3);
    // provisional entry keeps draft values; conflicts require explicit resubmit
    expect(result.entries).toEqual([entry('e1', { servings: 2, note: 'draft', food_id: 'food-2' })]);
  });

  it('flags user-delete vs server-edit as an existence conflict', () => {
    const base = [entry('e1', { servings: 1, note: 'base' })];
    const draft: CompositionEntry[] = [];
    const server = [entry('e1', { servings: 2, note: 'server-edit' })];

    const result = mergeMealComposition(base, draft, server);

    expect(result.conflicts).toEqual([
      {
        entry_key: 'e1',
        field: 'existence',
        base: true,
        draft: false,
        server: true,
      },
    ]);
    expect(result.entries).toEqual([entry('e1', { servings: 2, note: 'server-edit' })]);
  });

  it('flags server-delete vs user-edit as an existence conflict', () => {
    const base = [entry('e1', { servings: 1, note: 'base' })];
    const draft = [entry('e1', { servings: 4, note: 'user-edit' })];
    const server: CompositionEntry[] = [];

    const result = mergeMealComposition(base, draft, server);

    expect(result.conflicts).toEqual([
      {
        entry_key: 'e1',
        field: 'existence',
        base: true,
        draft: true,
        server: false,
      },
    ]);
    expect(result.entries).toEqual([entry('e1', { servings: 4, note: 'user-edit' })]);
  });

  it('preserves temporary local additions and server-only additions', () => {
    const localId = createLocalCompositionEntryId('local-1');
    const base = [entry('e1')];
    const draft = [entry('e1'), entry(localId, { food_id: 'food-new', food_name: '新菜', servings: 1 })];
    const server = [entry('e1'), entry('e2', { food_id: 'food-server', food_name: '服务端菜', servings: 1 })];

    const result = mergeMealComposition(base, draft, server);

    expect(result.conflicts).toEqual([]);
    expect(result.entries.map((item) => item.id)).toEqual(['e1', localId, 'e2']);
    expect(result.entries.find((item) => item.id === localId)).toMatchObject({
      food_id: 'food-new',
      food_name: '新菜',
    });
  });

  it('drops an entry when both sides delete it', () => {
    const base = [entry('e1'), entry('e2')];
    const draft = [entry('e1')];
    const server = [entry('e1')];

    const result = mergeMealComposition(base, draft, server);

    expect(result.entries.map((item) => item.id)).toEqual(['e1']);
    expect(result.conflicts).toEqual([]);
  });
});
