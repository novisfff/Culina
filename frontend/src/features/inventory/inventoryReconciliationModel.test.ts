import { describe, expect, it } from 'vitest';
import type {
  ExactIngredientReconciliationGroup,
  FoodReconciliationGroup,
  IngredientInventoryState,
  InventoryReconciliationResponse,
  PresenceIngredientReconciliationGroup,
  ReconciliationBatch,
} from '../../api/types';
import {
  AVAILABILITY_LEVEL_LABELS,
  CONFIRMATION_STATUS_LABELS,
  SCOPE_LABELS,
  buildBatchCreateIntent,
  buildBatchUpdateFromGroup,
  buildExactAdjustBatchesIntent,
  buildExactConfirmAllIntent,
  buildExactSetAbsentIntent,
  buildExactTotalAdjustmentSuggestion,
  buildFoodConfirmIntent,
  buildFoodSetAbsentIntent,
  buildFoodSetStockIntent,
  buildGroupHeadline,
  buildPresenceIntent,
  buildReconciliationPayload,
  canSubmitReconciliation,
  countExpiredPhysicalBatches,
  createEmptyDraft,
  formatSubmitSummaryLines,
  isPhysicalBatchExpired,
  progressCounts,
  reconciliationGroupTargetKey,
  removeIntent,
  replayReconciliationDraft,
  sortGroupsForDisplay,
  sumExactRemainingQuantity,
  summarizeReconciliationDraft,
  upsertIntent,
  validateReconciliationDraft,
  type InventoryReconciliationDraft,
} from './inventoryReconciliationModel';

const REFERENCE_DATE = '2026-07-11';
const NOW = '2026-07-11T08:00:00.000Z';
const FAMILY_ID = 'family-1';
const USER_ID = 'user-1';

function makeBatch(overrides: Partial<ReconciliationBatch> & Pick<ReconciliationBatch, 'inventory_item_id'>): ReconciliationBatch {
  return {
    row_version: 1,
    remaining_quantity: 3,
    unit: '个',
    status: 'fresh',
    purchase_date: '2026-07-01',
    expiry_date: '2026-07-20',
    storage_location: '冷藏',
    notes: '',
    confirmation_status: 'never_confirmed',
    last_confirmed_at: null,
    ...overrides,
  };
}

function makeExactGroup(
  overrides: Partial<ExactIngredientReconciliationGroup> &
    Pick<ExactIngredientReconciliationGroup, 'ingredient_id' | 'ingredient_name'>,
): ExactIngredientReconciliationGroup {
  return {
    kind: 'exact_ingredient',
    ingredient_row_version: 4,
    confirmation_status: 'never_confirmed',
    last_confirmed_at: null,
    batches: [
      makeBatch({ inventory_item_id: 'batch-1', remaining_quantity: 4, unit: '个' }),
      makeBatch({
        inventory_item_id: 'batch-2',
        remaining_quantity: 2,
        unit: '个',
        expiry_date: '2026-07-05',
        row_version: 2,
      }),
    ],
    pending_shopping_item_id: null,
    ...overrides,
  };
}

function makeState(overrides: Partial<IngredientInventoryState> = {}): IngredientInventoryState {
  return {
    id: 'state-1',
    family_id: FAMILY_ID,
    ingredient_id: 'ing-salt',
    availability_level: 'present_unknown',
    inventory_status: 'fresh',
    purchase_date: '2026-06-01',
    expiry_date: null,
    storage_location: '常温',
    notes: '',
    expiry_alert_snoozed_until: null,
    expiry_reviewed_at: null,
    expiry_reviewed_by: null,
    last_confirmed_at: null,
    last_confirmed_by: null,
    last_confirmation_source: null,
    row_version: 3,
    created_at: '2026-06-01T00:00:00.000Z',
    updated_at: '2026-06-01T00:00:00.000Z',
    ...overrides,
  };
}

function makePresenceGroup(
  overrides: Partial<PresenceIngredientReconciliationGroup> &
    Pick<PresenceIngredientReconciliationGroup, 'ingredient_id' | 'ingredient_name'> = {
    ingredient_id: 'ing-salt',
    ingredient_name: '盐',
  },
): PresenceIngredientReconciliationGroup {
  const state = overrides.state ?? makeState({ ingredient_id: overrides.ingredient_id });
  return {
    kind: 'presence_ingredient',
    ingredient_row_version: 2,
    confirmation_status: 'stale',
    pending_shopping_item_id: null,
    state,
    ...overrides,
  };
}

function makeFoodGroup(
  overrides: Partial<FoodReconciliationGroup> & Pick<FoodReconciliationGroup, 'food_id' | 'food_name'> = {
    food_id: 'food-beef',
    food_name: '卤牛肉',
  },
): FoodReconciliationGroup {
  return {
    kind: 'food',
    row_version: 5,
    stock_quantity: 2,
    stock_unit: '份',
    expiry_date: '2026-07-09',
    storage_location: '冷藏',
    confirmation_status: 'current',
    last_confirmed_at: '2026-07-10T00:00:00.000Z',
    ...overrides,
  };
}

function makeResponse(groups: InventoryReconciliationResponse['groups']): InventoryReconciliationResponse {
  return {
    business_date: REFERENCE_DATE,
    business_timezone: 'Asia/Shanghai',
    generated_at: NOW,
    summary: {
      total_groups: groups.length,
      never_confirmed: groups.filter((group) => group.confirmation_status === 'never_confirmed').length,
      stale: groups.filter((group) => group.confirmation_status === 'stale').length,
      expired_physical_batches: countExpiredPhysicalBatches(groups, REFERENCE_DATE),
    },
    groups,
  };
}

describe('inventoryReconciliationModel labels and grouping', () => {
  it('exposes scope and confirmation labels for chips', () => {
    expect(SCOPE_LABELS.suggested).toBe('建议确认');
    expect(SCOPE_LABELS.refrigerated).toBe('冷藏');
    expect(SCOPE_LABELS.frozen).toBe('冷冻');
    expect(SCOPE_LABELS.room_temperature).toBe('常温');
    expect(SCOPE_LABELS.all).toBe('全部');
    expect(CONFIRMATION_STATUS_LABELS.never_confirmed).toBe('待确认');
    expect(CONFIRMATION_STATUS_LABELS.current).toBe('刚确认过');
    expect(CONFIRMATION_STATUS_LABELS.stale).toBe('建议再确认');
    expect(AVAILABILITY_LEVEL_LABELS.low).toBe('少量');
    expect(AVAILABILITY_LEVEL_LABELS.absent).toBe('没有了');
  });

  it('includes expired physical batches in exact remaining calculations', () => {
    const eggs = makeExactGroup({ ingredient_id: 'ing-egg', ingredient_name: '鸡蛋' });
    expect(isPhysicalBatchExpired(eggs.batches[1], REFERENCE_DATE)).toBe(true);
    expect(countExpiredPhysicalBatches([eggs], REFERENCE_DATE)).toBe(1);
    const remaining = sumExactRemainingQuantity(eggs);
    expect(remaining.total).toBe(6);
    expect(remaining.batchCount).toBe(2);
    expect(remaining.label).toContain('6');
  });

  it('builds household headlines for exact, presence, and food groups', () => {
    const eggs = makeExactGroup({ ingredient_id: 'ing-egg', ingredient_name: '鸡蛋' });
    const salt = makePresenceGroup({ ingredient_id: 'ing-salt', ingredient_name: '盐' });
    const beef = makeFoodGroup();
    expect(buildGroupHeadline(eggs, REFERENCE_DATE).detail).toContain('批次');
    expect(buildGroupHeadline(eggs, REFERENCE_DATE).hasExpiredPhysicalBatch).toBe(true);
    expect(buildGroupHeadline(salt, REFERENCE_DATE).detail).toContain('只记录有无');
    expect(buildGroupHeadline(beef, REFERENCE_DATE).detail).toContain('2 份');
  });
});

describe('inventoryReconciliationModel intents and payload', () => {
  it('suggests clearing expired batches first and then the earliest remaining batch', () => {
    const tomatoes = makeExactGroup({
      ingredient_id: 'ing-tomato',
      ingredient_name: '番茄',
      default_unit: '个',
      unit_conversions: [],
      batches: [
        makeBatch({
          inventory_item_id: 'batch-newer',
          remaining_quantity: 4,
          expiry_date: '2026-07-20',
          purchase_date: '2026-07-08',
        }),
        makeBatch({
          inventory_item_id: 'batch-expired',
          remaining_quantity: 2,
          expiry_date: '2026-07-05',
          purchase_date: '2026-06-25',
        }),
      ],
    });

    const suggestion = buildExactTotalAdjustmentSuggestion({
      group: tomatoes,
      actualQuantity: '3',
      actualUnit: '个',
      referenceDate: REFERENCE_DATE,
    });

    expect(suggestion.ok).toBe(true);
    if (!suggestion.ok) return;
    expect(suggestion.intent.action).toBe('adjust_batches');
    expect(suggestion.processedBatchIds).toEqual(['batch-expired', 'batch-newer']);
    expect(suggestion.retainedBatchIds).toEqual(['batch-newer']);
    expect(suggestion.intent.updates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ inventoryItemId: 'batch-expired', actualRemainingQuantity: '0' }),
        expect.objectContaining({ inventoryItemId: 'batch-newer', actualRemainingQuantity: '3' }),
      ]),
    );
  });

  it('uses reliable ingredient conversions and rejects totals above recorded inventory', () => {
    const rice = makeExactGroup({
      ingredient_id: 'ing-rice',
      ingredient_name: '大米',
      default_unit: '克',
      unit_conversions: [{ unit: '斤', ratio_to_default: 500 }],
      batches: [
        makeBatch({ inventory_item_id: 'rice-grams', remaining_quantity: 500, unit: '克' }),
        makeBatch({ inventory_item_id: 'rice-jin', remaining_quantity: 1, unit: '斤' }),
      ],
    });

    const converted = buildExactTotalAdjustmentSuggestion({
      group: rice,
      actualQuantity: '1',
      actualUnit: '斤',
      referenceDate: REFERENCE_DATE,
    });
    expect(converted.ok).toBe(true);
    if (converted.ok) {
      expect(converted.actualQuantityInDefaultUnit).toBe(500);
      expect(converted.recordedQuantityInDefaultUnit).toBe(1000);
    }

    expect(
      buildExactTotalAdjustmentSuggestion({
        group: rice,
        actualQuantity: '3',
        actualUnit: '斤',
        referenceDate: REFERENCE_DATE,
      }),
    ).toMatchObject({ ok: false, reason: 'above_recorded' });
  });

  it('creates no intent for untouched groups and only submits touched ones', () => {
    const eggs = makeExactGroup({ ingredient_id: 'ing-egg', ingredient_name: '鸡蛋' });
    const salt = makePresenceGroup();
    const beef = makeFoodGroup();
    let draft = createEmptyDraft({
      familyId: FAMILY_ID,
      userId: USER_ID,
      scope: 'refrigerated',
      now: NOW,
      clientRequestId: 'req-1',
    });
    expect(draft.intents).toHaveLength(0);
    expect(validateReconciliationDraft(draft, [eggs, salt, beef])[0]?.code).toBe('empty_operation');

    draft = upsertIntent(draft, buildExactConfirmAllIntent(eggs), NOW);
    draft = upsertIntent(
      draft,
      buildPresenceIntent({ group: salt, availabilityLevel: 'low' }),
      NOW,
    );
    draft = upsertIntent(draft, buildFoodConfirmIntent(beef), NOW);

    const payload = buildReconciliationPayload(draft);
    expect(payload.client_request_id).toBe('req-1');
    expect(payload.scope).toBe('refrigerated');
    expect(payload.storage_location).toBe('冷藏');
    expect(payload.groups).toHaveLength(3);
    expect(payload.groups.map((group) => group.kind)).toEqual([
      'exact_ingredient',
      'presence_ingredient',
      'food',
    ]);
  });

  it('builds exact confirm/set_absent/adjust with unique client_line_id creates', () => {
    const eggs = makeExactGroup({ ingredient_id: 'ing-egg', ingredient_name: '鸡蛋' });
    const confirm = buildExactConfirmAllIntent(eggs);
    expect(confirm.action).toBe('confirm_all');
    expect(confirm.observedBatches).toHaveLength(2);
    expect(confirm.updates).toHaveLength(0);

    const absent = buildExactSetAbsentIntent(eggs);
    expect(absent.action).toBe('set_absent');
    expect(absent.updates.every((update) => update.actualRemainingQuantity === '0')).toBe(true);
    expect(absent.updates).toHaveLength(2);

    const update = buildBatchUpdateFromGroup(eggs, 'batch-1', { actualRemainingQuantity: '5' });
    expect(update?.actualRemainingQuantity).toBe('5');
    const createA = buildBatchCreateIntent({
      actualRemainingQuantity: '1',
      unit: '个',
      inventoryStatus: 'fresh',
      purchaseDate: REFERENCE_DATE,
      expiryDate: null,
      storageLocation: '冷藏',
      clientLineId: 'line-a',
    });
    const createB = buildBatchCreateIntent({
      actualRemainingQuantity: '2',
      unit: '个',
      inventoryStatus: 'fresh',
      purchaseDate: REFERENCE_DATE,
      expiryDate: null,
      storageLocation: '冷藏',
      clientLineId: 'line-b',
    });
    expect(createA.clientLineId).not.toBe(createB.clientLineId);
    const adjust = buildExactAdjustBatchesIntent({
      group: eggs,
      updates: [update!],
      creates: [createA, createB],
    });
    expect(adjust.action).toBe('adjust_batches');
    expect(adjust.creates.map((entry) => entry.clientLineId)).toEqual(['line-a', 'line-b']);

    const payload = buildReconciliationPayload({
      ...createEmptyDraft({
        familyId: FAMILY_ID,
        userId: USER_ID,
        scope: 'all',
        now: NOW,
        clientRequestId: 'req-adjust',
      }),
      intents: [adjust],
    });
    const group = payload.groups[0];
    if (group.kind !== 'exact_ingredient') throw new Error('expected exact');
    expect(group.creates[0].client_line_id).toBe('line-a');
    expect(group.creates[0].actual_remaining_quantity).toBe(1);
    expect(group.updates[0].actual_remaining_quantity).toBe(5);
  });

  it('rejects exact batch dates where expiry is before purchase locally', () => {
    const eggs = makeExactGroup({ ingredient_id: 'ing-egg', ingredient_name: '鸡蛋' });
    const update = buildBatchUpdateFromGroup(eggs, 'batch-1', {
      purchaseDate: '2026-07-12',
      expiryDate: '2026-07-01',
    });
    const create = buildBatchCreateIntent({
      actualRemainingQuantity: '1',
      unit: '个',
      inventoryStatus: 'fresh',
      purchaseDate: '2026-07-12',
      expiryDate: '2026-07-01',
      storageLocation: '冷藏',
      clientLineId: 'line-invalid-date-range',
    });
    const draft = {
      ...createEmptyDraft({
        familyId: FAMILY_ID,
        userId: USER_ID,
        scope: 'refrigerated',
        now: NOW,
      }),
      intents: [
        buildExactAdjustBatchesIntent({
          group: eggs,
          updates: [update!],
          creates: [create],
        }),
      ],
    };

    expect(validateReconciliationDraft(draft, [eggs])).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          field: 'batch:batch-1:expiryDate',
          code: 'invalid_date_range',
        }),
        expect.objectContaining({
          field: 'create:line-invalid-date-range:expiryDate',
          code: 'invalid_date_range',
        }),
      ]),
    );
  });

  it('handles presence four-state and food confirm/set_stock/absent branches', () => {
    const salt = makePresenceGroup();
    const beef = makeFoodGroup();
    const low = buildPresenceIntent({ group: salt, availabilityLevel: 'low' });
    expect(low.availabilityLevel).toBe('low');
    expect(low.storageLocation).toBe('常温');
    const gone = buildPresenceIntent({ group: salt, availabilityLevel: 'absent' });
    expect(gone.purchaseDate).toBeNull();
    expect(gone.expiryDate).toBeNull();
    expect(gone.storageLocation).toBeNull();

    const confirm = buildFoodConfirmIntent(beef);
    expect(confirm.action).toBe('confirm');
    expect(confirm.stockQuantity).toBeNull();
    const setStock = buildFoodSetStockIntent({ group: beef, stockQuantity: '3' });
    expect(setStock.action).toBe('set_stock');
    expect(setStock.stockQuantity).toBe('3');
    const foodAbsent = buildFoodSetAbsentIntent(beef);
    expect(foodAbsent.stockQuantity).toBe('0');

    const payload = buildReconciliationPayload({
      ...createEmptyDraft({
        familyId: FAMILY_ID,
        userId: USER_ID,
        scope: 'all',
        now: NOW,
        clientRequestId: 'req-food',
      }),
      intents: [low, setStock],
    });
    expect(payload.groups[0].kind).toBe('presence_ingredient');
    expect(payload.groups[1].kind).toBe('food');
    if (payload.groups[1].kind === 'food') {
      expect(payload.groups[1].stock_quantity).toBe(3);
    }
  });

  it('rejects a presence-state expiry date before its purchase date locally', () => {
    const salt = makePresenceGroup();
    const draft = {
      ...createEmptyDraft({
        familyId: FAMILY_ID,
        userId: USER_ID,
        scope: 'all',
        now: NOW,
      }),
      intents: [
        buildPresenceIntent({
          group: salt,
          availabilityLevel: 'sufficient',
          purchaseDate: '2026-07-12',
          expiryDate: '2026-07-01',
        }),
      ],
    };

    expect(validateReconciliationDraft(draft, [salt])).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          field: 'expiryDate',
          code: 'invalid_date_range',
        }),
      ]),
    );
  });

  it('rejects a Food stock total with more than one decimal locally', () => {
    const beef = makeFoodGroup();
    const draft = {
      ...createEmptyDraft({
        familyId: FAMILY_ID,
        userId: USER_ID,
        scope: 'all',
        now: NOW,
      }),
      intents: [buildFoodSetStockIntent({ group: beef, stockQuantity: '1.25' })],
    };

    expect(validateReconciliationDraft(draft, [beef])).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          field: 'stockQuantity',
          code: 'invalid_quantity',
          message: expect.stringContaining('最多保留 1 位小数'),
        }),
      ]),
    );
  });

  it('requires a storage location for positive Food stock locally', () => {
    const beef = makeFoodGroup();
    const draft = {
      ...createEmptyDraft({
        familyId: FAMILY_ID,
        userId: USER_ID,
        scope: 'all',
        now: NOW,
      }),
      intents: [
        buildFoodSetStockIntent({
          group: beef,
          stockQuantity: '2',
          storageLocation: '   ',
        }),
      ],
    };

    expect(validateReconciliationDraft(draft, [beef])).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          field: 'storageLocation',
          code: 'invalid_target',
        }),
      ]),
    );
  });

  it('summarizes only touched intents for submit preview', () => {
    const eggs = makeExactGroup({ ingredient_id: 'ing-egg', ingredient_name: '鸡蛋' });
    const salt = makePresenceGroup();
    const beef = makeFoodGroup();
    let draft = createEmptyDraft({
      familyId: FAMILY_ID,
      userId: USER_ID,
      scope: 'all',
      now: NOW,
    });
    draft = upsertIntent(draft, buildExactConfirmAllIntent(eggs), NOW);
    draft = upsertIntent(draft, buildPresenceIntent({ group: salt, availabilityLevel: 'low' }), NOW);
    draft = upsertIntent(draft, buildFoodSetAbsentIntent(beef), NOW);
    draft = upsertIntent(
      draft,
      buildExactAdjustBatchesIntent({
        group: makeExactGroup({ ingredient_id: 'ing-milk', ingredient_name: '牛奶' }),
        updates: [
          buildBatchUpdateFromGroup(
            makeExactGroup({ ingredient_id: 'ing-milk', ingredient_name: '牛奶' }),
            'batch-1',
            { actualRemainingQuantity: '1' },
          )!,
        ],
        creates: [
          buildBatchCreateIntent({
            actualRemainingQuantity: '1',
            unit: '盒',
            inventoryStatus: 'fresh',
            purchaseDate: REFERENCE_DATE,
            expiryDate: null,
            storageLocation: '冷藏',
            clientLineId: 'line-unique',
          }),
        ],
      }),
      NOW,
    );
    const summary = summarizeReconciliationDraft(draft);
    expect(summary.confirmCount).toBe(1);
    expect(summary.lowCount).toBe(1);
    expect(summary.absentCount).toBe(1);
    expect(summary.adjustedCount).toBe(1);
    expect(summary.createdBatchCount).toBe(1);
    expect(summary.totalTouched).toBe(4);
    expect(formatSubmitSummaryLines(summary).map((line) => line.label)).toEqual([
      '确认无误',
      '库存数量调整',
      '标记少量',
      '调整为没有',
      '新增漏记批次',
    ]);
  });

  it('uses explicit referenceDate for expired physical inclusion, never todayKey', () => {
    const batch = makeBatch({
      inventory_item_id: 'batch-expired',
      expiry_date: '2026-07-10',
      remaining_quantity: 1,
    });
    expect(isPhysicalBatchExpired(batch, '2026-07-11')).toBe(true);
    expect(isPhysicalBatchExpired(batch, '2026-07-10')).toBe(false);
    expect(isPhysicalBatchExpired(batch, '2026-07-09')).toBe(false);
  });
});

describe('inventoryReconciliationModel draft replay', () => {
  function baseDraft(intents: InventoryReconciliationDraft['intents']): InventoryReconciliationDraft {
    return {
      schemaVersion: 1,
      familyId: FAMILY_ID,
      userId: USER_ID,
      clientRequestId: 'req-restore',
      scope: 'refrigerated',
      createdAt: NOW,
      savedAt: NOW,
      intents,
    };
  }

  it('preserves valid same-version intents and client request id', () => {
    const eggs = makeExactGroup({ ingredient_id: 'ing-egg', ingredient_name: '鸡蛋' });
    const salt = makePresenceGroup();
    const beef = makeFoodGroup();
    const draft = baseDraft([
      buildExactConfirmAllIntent(eggs),
      buildPresenceIntent({ group: salt, availabilityLevel: 'sufficient' }),
      buildFoodConfirmIntent(beef),
    ]);
    const result = replayReconciliationDraft({
      draft,
      latest: makeResponse([eggs, salt, beef]),
      familyId: FAMILY_ID,
      userId: USER_ID,
      referenceDate: REFERENCE_DATE,
      now: '2026-07-11T10:00:00.000Z',
    });
    expect(result.discardedReason).toBeNull();
    expect(result.restoredDraft?.clientRequestId).toBe('req-restore');
    expect(result.restoredDraft?.intents).toHaveLength(3);
    expect(result.conflicts).toHaveLength(0);
    expect(result.newlyDiscoveredTargetKeys).toHaveLength(0);
  });

  it('marks version-changed intents as conflicts but rebinds for reconfirmation', () => {
    const eggs = makeExactGroup({ ingredient_id: 'ing-egg', ingredient_name: '鸡蛋' });
    const draft = baseDraft([buildExactConfirmAllIntent(eggs)]);
    const newer = makeExactGroup({
      ingredient_id: 'ing-egg',
      ingredient_name: '鸡蛋',
      ingredient_row_version: 9,
      batches: eggs.batches.map((batch) => ({ ...batch, row_version: batch.row_version + 1 })),
    });
    const result = replayReconciliationDraft({
      draft,
      latest: makeResponse([newer]),
      familyId: FAMILY_ID,
      userId: USER_ID,
      referenceDate: REFERENCE_DATE,
      now: NOW,
    });
    expect(result.conflicts.some((conflict) => conflict.code === 'stale_version')).toBe(true);
    expect(result.restoredDraft?.intents).toHaveLength(1);
    expect(result.restoredDraft?.clientRequestId).toBe('req-restore');
  });

  it('removes deleted entities with missing_target explanation', () => {
    const eggs = makeExactGroup({ ingredient_id: 'ing-egg', ingredient_name: '鸡蛋' });
    const draft = baseDraft([buildExactConfirmAllIntent(eggs)]);
    const result = replayReconciliationDraft({
      draft,
      latest: makeResponse([]),
      familyId: FAMILY_ID,
      userId: USER_ID,
      referenceDate: REFERENCE_DATE,
      now: NOW,
    });
    expect(result.conflicts).toEqual([
      expect.objectContaining({
        targetKey: reconciliationGroupTargetKey(eggs),
        code: 'missing_target',
      }),
    ]);
    expect(result.restoredDraft?.intents).toHaveLength(0);
  });

  it('adds newly discovered entities to view keys but does not auto-confirm them', () => {
    const eggs = makeExactGroup({ ingredient_id: 'ing-egg', ingredient_name: '鸡蛋' });
    const milk = makeExactGroup({ ingredient_id: 'ing-milk', ingredient_name: '牛奶' });
    const draft = baseDraft([buildExactConfirmAllIntent(eggs)]);
    const result = replayReconciliationDraft({
      draft,
      latest: makeResponse([eggs, milk]),
      familyId: FAMILY_ID,
      userId: USER_ID,
      referenceDate: REFERENCE_DATE,
      now: NOW,
    });
    expect(result.newlyDiscoveredTargetKeys).toEqual([reconciliationGroupTargetKey(milk)]);
    expect(result.restoredDraft?.intents).toHaveLength(1);
    expect(result.restoredDraft?.intents[0]).toMatchObject({ ingredientId: 'ing-egg' });
  });

  it('invalidates tracking-mode-changed intents', () => {
    const exact = makeExactGroup({ ingredient_id: 'ing-salt', ingredient_name: '盐' });
    const presence = makePresenceGroup({ ingredient_id: 'ing-salt', ingredient_name: '盐' });
    const draft = baseDraft([buildExactConfirmAllIntent(exact)]);
    const result = replayReconciliationDraft({
      draft,
      latest: makeResponse([presence]),
      familyId: FAMILY_ID,
      userId: USER_ID,
      referenceDate: REFERENCE_DATE,
      now: NOW,
    });
    expect(result.conflicts.some((conflict) => conflict.code === 'tracking_mode_changed')).toBe(true);
    expect(result.restoredDraft?.intents).toHaveLength(0);
  });

  it('discards drafts older than 24 hours', () => {
    const eggs = makeExactGroup({ ingredient_id: 'ing-egg', ingredient_name: '鸡蛋' });
    const draft = {
      ...baseDraft([buildExactConfirmAllIntent(eggs)]),
      savedAt: '2026-07-10T07:00:00.000Z',
    };
    const result = replayReconciliationDraft({
      draft,
      latest: makeResponse([eggs]),
      familyId: FAMILY_ID,
      userId: USER_ID,
      referenceDate: REFERENCE_DATE,
      now: '2026-07-11T08:00:00.000Z',
    });
    expect(result.discardedReason).toBe('expired');
    expect(result.restoredDraft).toBeNull();
  });

  it('discards family/user/schema mismatches without preserving client request id', () => {
    const eggs = makeExactGroup({ ingredient_id: 'ing-egg', ingredient_name: '鸡蛋' });
    const draft = baseDraft([buildExactConfirmAllIntent(eggs)]);
    expect(
      replayReconciliationDraft({
        draft: { ...draft, familyId: 'other-family' },
        latest: makeResponse([eggs]),
        familyId: FAMILY_ID,
        userId: USER_ID,
        referenceDate: REFERENCE_DATE,
        now: NOW,
      }).discardedReason,
    ).toBe('family_mismatch');
    expect(
      replayReconciliationDraft({
        draft: { ...draft, userId: 'other-user' },
        latest: makeResponse([eggs]),
        familyId: FAMILY_ID,
        userId: USER_ID,
        referenceDate: REFERENCE_DATE,
        now: NOW,
      }).discardedReason,
    ).toBe('user_mismatch');
    expect(
      replayReconciliationDraft({
        draft: { ...draft, schemaVersion: 2 as 1 },
        latest: makeResponse([eggs]),
        familyId: FAMILY_ID,
        userId: USER_ID,
        referenceDate: REFERENCE_DATE,
        now: NOW,
      }).discardedReason,
    ).toBe('schema_mismatch');
  });

  it('sorts conflicts first and keeps progress based on touched intents only', () => {
    const eggs = makeExactGroup({ ingredient_id: 'ing-egg', ingredient_name: '鸡蛋' });
    const salt = makePresenceGroup();
    const beef = makeFoodGroup();
    let draft = createEmptyDraft({
      familyId: FAMILY_ID,
      userId: USER_ID,
      scope: 'all',
      now: NOW,
    });
    draft = upsertIntent(draft, buildExactConfirmAllIntent(eggs), NOW);
    const sorted = sortGroupsForDisplay({
      groups: [beef, salt, eggs],
      draft,
      conflictTargetKeys: [reconciliationGroupTargetKey(salt)],
    });
    expect(sorted.map((group) => reconciliationGroupTargetKey(group))[0]).toBe(
      reconciliationGroupTargetKey(salt),
    );
    expect(progressCounts({ groups: [eggs, salt, beef], draft })).toEqual({ checked: 1, total: 3 });
    draft = removeIntent(draft, reconciliationGroupTargetKey(eggs), NOW);
    expect(draft.intents).toHaveLength(0);
    expect(canSubmitReconciliation(draft, [eggs])).toBe(false);
  });
});
