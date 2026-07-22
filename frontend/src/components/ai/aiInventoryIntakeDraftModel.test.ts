import { describe, expect, it } from 'vitest';

import {
  groupInventoryIntakeItems,
  inventoryIntakeActionOptions,
  inventoryIntakeDraftFromRecord,
  inventoryIntakeItemSummary,
  patchInventoryIntakeDate,
  patchInventoryIntakeItem,
  validateInventoryIntakeDraftForSubmit,
  type InventoryIntakeDraft,
} from './aiInventoryIntakeDraftModel';

function baseDraft(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    draftType: 'inventory_intake',
    schemaVersion: 'inventory_intake.v1',
    clientRequestId: 'ai-inventory-intake-test',
    sourceType: 'receipt_image',
    sourceReference: { mediaId: 'media-1' },
    intakeDate: '2026-07-21',
    intakeDateSource: 'receipt',
    items: [],
    ignoredItems: [],
    summary: {},
    ...overrides,
  };
}

function shoppingExact(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    lineId: 'egg',
    sourceLineId: 'receipt-egg',
    sourceText: '鸡蛋 2个',
    sourceKind: 'shopping_item',
    action: 'stock_and_fulfill',
    shoppingItemId: 'shopping-egg',
    expectedShoppingItemRowVersion: 3,
    title: '鸡蛋',
    targetKind: 'exact_ingredient',
    targetId: 'ingredient-egg',
    expectedIngredientRowVersion: 7,
    plannedQuantity: '2',
    plannedUnit: '个',
    enteredQuantity: '2',
    enteredUnit: '个',
    packageConversion: null,
    storageLocation: '冷藏',
    expiryDate: '2026-07-28',
    inventoryStatus: 'fresh',
    notes: '',
    before: { shoppingItem: { id: 'shopping-egg', rowVersion: 3 } },
    ...overrides,
  };
}

function directFood(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    lineId: 'milk',
    sourceLineId: 'receipt-milk',
    sourceText: '牛奶 1盒',
    sourceKind: 'direct',
    action: 'stock_only',
    title: '牛奶',
    targetKind: 'food',
    targetId: 'food-milk',
    expectedFoodRowVersion: 2,
    enteredQuantity: '1',
    enteredUnit: '盒',
    packageConversion: null,
    storageLocation: '冷藏',
    expiryDate: null,
    notes: '',
    before: { food: { id: 'food-milk', rowVersion: 2 } },
    ...overrides,
  };
}

function presenceItem(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    lineId: 'oil',
    sourceLineId: 'receipt-oil',
    sourceText: '食用油',
    sourceKind: 'shopping_item',
    action: 'stock_and_fulfill',
    shoppingItemId: 'shopping-oil',
    expectedShoppingItemRowVersion: 1,
    title: '食用油',
    targetKind: 'presence_ingredient',
    targetId: 'ingredient-oil',
    expectedIngredientRowVersion: 4,
    stateId: 'state-oil',
    expectedStateRowVersion: 2,
    resultingAvailabilityLevel: 'sufficient',
    storageLocation: '储物柜',
    notes: '',
    before: {},
    ...overrides,
  };
}

describe('aiInventoryIntakeDraftModel', () => {
  it('groups shopping direct and ignored rows in source order', () => {
    const draft = inventoryIntakeDraftFromRecord({
      draftType: 'inventory_intake',
      schemaVersion: 'inventory_intake.v1',
      intakeDate: '2026-07-21',
      intakeDateSource: 'receipt',
      items: [
        { lineId: 'egg', sourceKind: 'shopping_item', action: 'stock_and_fulfill', title: '鸡蛋' },
        { lineId: 'milk', sourceKind: 'direct', action: 'stock_only', title: '牛奶' },
        { lineId: 'bread', sourceKind: 'shopping_item', action: 'skip', title: '面包' },
      ],
      ignoredItems: [{ sourceLineId: 'bags', displayName: '垃圾袋', reason: '非食品库存对象' }],
    });
    const groups = groupInventoryIntakeItems(draft);
    expect(groups.shopping.map((item) => item.lineId)).toEqual(['egg', 'bread']);
    expect(groups.direct.map((item) => item.lineId)).toEqual(['milk']);
    expect(groups.ignored.map((item) => item.sourceLineId)).toEqual(['bags']);
  });

  it('exposes only source-compatible actions', () => {
    expect(inventoryIntakeActionOptions('shopping_item').map((item) => item.value))
      .toEqual(['stock_and_fulfill', 'fulfill_without_stock', 'skip']);
    expect(inventoryIntakeActionOptions('direct').map((item) => item.value))
      .toEqual(['stock_only', 'skip']);
  });

  it('patches editable fields without dropping protected server fields', () => {
    const draft = inventoryIntakeDraftFromRecord(baseDraft({
      items: [shoppingExact()],
    }));
    const patched = patchInventoryIntakeItem(draft, 'egg', {
      enteredQuantity: '1',
      enteredUnit: '个',
      storageLocation: '冷冻',
      notes: '部分买到',
    });
    const item = patched.items[0];
    expect(item.enteredQuantity).toBe('1');
    expect(item.storageLocation).toBe('冷冻');
    expect(item.notes).toBe('部分买到');
    expect(item.lineId).toBe('egg');
    expect(item.shoppingItemId).toBe('shopping-egg');
    expect(item.expectedShoppingItemRowVersion).toBe(3);
    expect(item.targetId).toBe('ingredient-egg');
    expect(item.expectedIngredientRowVersion).toBe(7);
    expect(item.plannedQuantity).toBe('2');
    expect(item.before).toEqual({ shoppingItem: { id: 'shopping-egg', rowVersion: 3 } });
  });

  it('ignores protected identity version and before fields in unchecked runtime patches', () => {
    const draft = inventoryIntakeDraftFromRecord(baseDraft({
      items: [shoppingExact()],
    }));
    const malicious = {
      action: 'skip',
      enteredQuantity: '9',
      lineId: 'forged',
      shoppingItemId: 'forged-shopping',
      expectedShoppingItemRowVersion: 99,
      targetId: 'forged-target',
      targetKind: 'food',
      plannedQuantity: '100',
      before: { forged: true },
      sourceKind: 'direct',
    } as Parameters<typeof patchInventoryIntakeItem>[2];
    const patched = patchInventoryIntakeItem(draft, 'egg', malicious);
    const item = patched.items[0];
    expect(item.action).toBe('skip');
    expect(item.enteredQuantity).toBe('9');
    expect(item.lineId).toBe('egg');
    expect(item.shoppingItemId).toBe('shopping-egg');
    expect(item.expectedShoppingItemRowVersion).toBe(3);
    expect(item.targetId).toBe('ingredient-egg');
    expect(item.targetKind).toBe('exact_ingredient');
    expect(item.plannedQuantity).toBe('2');
    expect(item.before).toEqual({ shoppingItem: { id: 'shopping-egg', rowVersion: 3 } });
    expect(item.sourceKind).toBe('shopping_item');
  });

  it('patches intake date only through the top-level helper', () => {
    const draft = inventoryIntakeDraftFromRecord(baseDraft({
      items: [shoppingExact()],
      intakeDateSource: 'receipt',
      clientRequestId: 'ai-inventory-intake-keep',
    }));
    const patched = patchInventoryIntakeDate(draft, '2026-07-22');
    expect(patched.intakeDate).toBe('2026-07-22');
    expect(patched.intakeDateSource).toBe('receipt');
    expect(patched.clientRequestId).toBe('ai-inventory-intake-keep');
    expect(patched.sourceType).toBe('receipt_image');
    expect(patched.items[0].lineId).toBe('egg');
  });

  it('recomputes auto default expiry when intake date changes, but keeps user overrides', () => {
    const draft = inventoryIntakeDraftFromRecord(baseDraft({
      intakeDate: '2026-07-21',
      items: [
        shoppingExact({
          lineId: 'auto-egg',
          title: '自动保质期鸡蛋',
          // 7 days after 2026-07-21
          expiryDate: '2026-07-28',
          before: {
            ingredient: {
              id: 'ingredient-egg',
              defaultExpiryMode: 'days',
              defaultExpiryDays: 7,
            },
          },
        }),
        shoppingExact({
          lineId: 'manual-egg',
          title: '手填保质期鸡蛋',
          // user override, not intake+7
          expiryDate: '2026-08-01',
          before: {
            ingredient: {
              id: 'ingredient-egg-2',
              defaultExpiryMode: 'days',
              defaultExpiryDays: 7,
            },
          },
        }),
        directFood({
          lineId: 'milk',
          expiryDate: '2026-07-30',
        }),
      ],
    }));

    const patched = patchInventoryIntakeDate(draft, '2026-07-23');
    expect(patched.intakeDate).toBe('2026-07-23');
    expect(patched.items.find((item) => item.lineId === 'auto-egg')?.expiryDate).toBe('2026-07-30');
    expect(patched.items.find((item) => item.lineId === 'manual-egg')?.expiryDate).toBe('2026-08-01');
    expect(patched.items.find((item) => item.lineId === 'milk')?.expiryDate).toBe('2026-07-30');
  });

  it('summarizes partial shopping purchase and remaining quantity', () => {
    const draft = inventoryIntakeDraftFromRecord(baseDraft({
      items: [shoppingExact({ enteredQuantity: '1', enteredUnit: '个', plannedQuantity: '2', plannedUnit: '个' })],
    }));
    expect(inventoryIntakeItemSummary(draft.items[0])).toContain('保留');
    expect(inventoryIntakeItemSummary(draft.items[0])).toMatch(/1/);
    expect(inventoryIntakeItemSummary(draft.items[0])).toMatch(/待买/);
  });

  it('summarizes direct row without claiming shopping completion', () => {
    const draft = inventoryIntakeDraftFromRecord(baseDraft({
      items: [directFood()],
    }));
    const summary = inventoryIntakeItemSummary(draft.items[0]);
    expect(summary).toMatch(/直接入库|只增加库存/);
    expect(summary).not.toMatch(/完成采购|完成购物|待买/);
  });

  it('validates exact and food quantity and unit', () => {
    const missingQty = inventoryIntakeDraftFromRecord(baseDraft({
      items: [shoppingExact({ enteredQuantity: '', enteredUnit: '个' })],
    }));
    expect(validateInventoryIntakeDraftForSubmit(missingQty as unknown as Record<string, unknown>))
      .toBe('请填写「鸡蛋」的实际入库数量');

    const missingUnit = inventoryIntakeDraftFromRecord(baseDraft({
      items: [shoppingExact({ enteredQuantity: '2', enteredUnit: '' })],
    }));
    expect(validateInventoryIntakeDraftForSubmit(missingUnit as unknown as Record<string, unknown>))
      .toBe('请填写「鸡蛋」的实际入库单位');

    const foodMissing = inventoryIntakeDraftFromRecord(baseDraft({
      items: [directFood({ enteredQuantity: '0', enteredUnit: '盒' })],
    }));
    expect(validateInventoryIntakeDraftForSubmit(foodMissing as unknown as Record<string, unknown>))
      .toBe('请填写「牛奶」的实际入库数量');
  });

  it('validates package conversion evidence', () => {
    const draft = inventoryIntakeDraftFromRecord(baseDraft({
      items: [shoppingExact({
        packageConversion: { ratio: '0', targetUnit: '', evidence: '' },
      })],
    }));
    expect(validateInventoryIntakeDraftForSubmit(draft as unknown as Record<string, unknown>))
      .toBe('请补全「鸡蛋」的包装换算倍率、目标单位和证据');

    const incomplete = inventoryIntakeDraftFromRecord(baseDraft({
      items: [shoppingExact({
        packageConversion: { ratio: '10', targetUnit: '克', evidence: '' },
      })],
    }));
    expect(validateInventoryIntakeDraftForSubmit(incomplete as unknown as Record<string, unknown>))
      .toBe('请补全「鸡蛋」的包装换算倍率、目标单位和证据');
  });

  it('allows presence intake without numeric quantity', () => {
    const draft = inventoryIntakeDraftFromRecord(baseDraft({
      items: [presenceItem({ enteredQuantity: null, enteredUnit: null })],
    }));
    expect(validateInventoryIntakeDraftForSubmit(draft as unknown as Record<string, unknown>)).toBe('');
  });

  it('rejects presence stock without expected ingredient row version', () => {
    const draft = inventoryIntakeDraftFromRecord(baseDraft({
      items: [presenceItem({ expectedIngredientRowVersion: null })],
    }));
    expect(validateInventoryIntakeDraftForSubmit(draft as unknown as Record<string, unknown>))
      .toBe('「食用油」缺少食材版本信息，请重新生成草稿');
  });

  it('rejects presence stock with stateId but missing state row version', () => {
    const draft = inventoryIntakeDraftFromRecord(baseDraft({
      items: [presenceItem({ expectedStateRowVersion: null })],
    }));
    expect(validateInventoryIntakeDraftForSubmit(draft as unknown as Record<string, unknown>))
      .toBe('「食用油」缺少库存状态版本信息，请重新生成草稿');
  });

  it('rejects empty action with row-named message even when another row is valid', () => {
    const draft = inventoryIntakeDraftFromRecord(baseDraft({
      items: [
        shoppingExact(),
        directFood({ action: '' }),
      ],
    }));
    expect(validateInventoryIntakeDraftForSubmit(draft as unknown as Record<string, unknown>))
      .toBe('请选择「牛奶」的处理方式');
  });

  it('validates storage and date range', () => {
    const noStorage = inventoryIntakeDraftFromRecord(baseDraft({
      items: [shoppingExact({ storageLocation: '' })],
    }));
    expect(validateInventoryIntakeDraftForSubmit(noStorage as unknown as Record<string, unknown>))
      .toBe('请填写「鸡蛋」的存放位置');

    const badExpiry = inventoryIntakeDraftFromRecord(baseDraft({
      items: [shoppingExact({ expiryDate: '2026-07-20' })],
      intakeDate: '2026-07-21',
    }));
    expect(validateInventoryIntakeDraftForSubmit(badExpiry as unknown as Record<string, unknown>))
      .toBe('「鸡蛋」的到期日不能早于入库日期');
  });

  it('rejects all skipped rows', () => {
    const draft = inventoryIntakeDraftFromRecord(baseDraft({
      items: [
        shoppingExact({ action: 'skip' }),
        directFood({ action: 'skip' }),
      ],
    }));
    expect(validateInventoryIntakeDraftForSubmit(draft as unknown as Record<string, unknown>))
      .toMatch(/至少选择一项|不能全部跳过|没有可提交/);
  });

  it('retains invalid empty identity when required draft fields are missing', () => {
    const draft = inventoryIntakeDraftFromRecord({
      intakeDate: '2026-07-21',
      items: [shoppingExact()],
    });
    expect(draft.draftType).toBe('');
    expect(draft.schemaVersion).toBe('');
    expect(validateInventoryIntakeDraftForSubmit(draft as unknown as Record<string, unknown>)).toMatch(/草稿类型|草稿版本|身份/);
  });

  it('rejects incompatible source and action combinations', () => {
    const draft = inventoryIntakeDraftFromRecord(baseDraft({
      items: [directFood({ action: 'stock_and_fulfill' })],
    }));
    expect(validateInventoryIntakeDraftForSubmit(draft as unknown as Record<string, unknown>))
      .toBe('「牛奶」的处理方式不正确');
  });
});
