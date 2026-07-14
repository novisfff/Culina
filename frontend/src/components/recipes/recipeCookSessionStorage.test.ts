import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Recipe } from '../../api/types';
import type { StorageLike } from '../../lib/storage';
import {
  buildActiveCookDescriptorKey,
  buildCookSessionV3Key,
  buildDefaultCookSessionV3,
  buildLegacyCookSessionV1Key,
  buildLegacyCookSessionV2Key,
  compareAndClearActiveCook,
  compareAndClearCookSession,
  loadOrMigrateCookSession,
  parseLegacyCookSession,
  readActiveCook,
  readCookSessionV3,
  saveCookSessionV3,
  type ActiveCookDescriptor,
  type RecipeCookSessionScope,
} from './recipeCookSessionStorage';

const SCOPE: RecipeCookSessionScope = { userId: 'u1', familyId: 'f1' };
const OTHER_SCOPE: RecipeCookSessionScope = { userId: 'u2', familyId: 'f1' };
const OTHER_FAMILY: RecipeCookSessionScope = { userId: 'u1', familyId: 'f2' };
const NOW = Date.parse('2026-07-12T12:00:00.000Z');
const NOW_ISO = '2026-07-12T12:00:00.000Z';

function memoryStorage(initial: Record<string, string> = {}): StorageLike & { data: Record<string, string> } {
  const data = { ...initial };
  return {
    data,
    getItem(key: string) {
      return Object.prototype.hasOwnProperty.call(data, key) ? data[key] : null;
    },
    setItem(key: string, value: string) {
      data[key] = value;
    },
    removeItem(key: string) {
      delete data[key];
    },
  };
}

function makeRecipe(overrides: Partial<Recipe> = {}): Pick<Recipe, 'id' | 'servings' | 'steps' | 'family_id'> {
  return {
    id: 'r1',
    family_id: 'f1',
    servings: 2,
    steps: [{ id: 'step-1', title: '备菜', text: '备菜', icon: 'pan', summary: '', estimated_minutes: null, tip: '', key_points: [] }],
    ...overrides,
  };
}

function descriptor(
  recipeId: string,
  foodPlanItemId: string | null,
  savedAt: string,
): ActiveCookDescriptor {
  return { version: 1, recipeId, foodPlanItemId, savedAt };
}

function makeVerifiedMigrationInput(
  overrides: Partial<Parameters<typeof loadOrMigrateCookSession>[0]> = {},
) {
  const recipe = makeRecipe();
  const storage =
    (overrides.storage as ReturnType<typeof memoryStorage> | undefined) ??
    memoryStorage({
      [buildLegacyCookSessionV2Key(recipe.id, null)]: JSON.stringify({
        version: 2,
        savedAt: '2026-07-12T10:00:00.000Z',
        source: 'direct',
        planItemId: null,
        session: {
          currentStepIndex: 0,
          checkedIngredientIds: ['ri-1'],
          completedStepIds: [],
          timers: [],
          activeTimerId: 'default-timer',
          servings: '2',
          date: '2026-07-12',
          mealType: 'dinner',
          createMealLog: false,
          planItemId: null,
          adjustments: '少油',
          resultNote: '',
          rating: '',
        },
      }),
    });

  return {
    scope: SCOPE,
    recipe,
    foodId: 'food-1',
    source: { kind: 'direct' as const },
    ownershipVerified: true,
    now: NOW,
    ...overrides,
    storage,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

describe('recipeCookSessionStorage keys', () => {
  it('builds distinct keys for users, families, direct, and plan sessions', () => {
    expect(buildCookSessionV3Key({ userId: 'u1', familyId: 'f1' }, 'r1', { kind: 'direct' })).toBe(
      'culina-recipe-cook-session-v3:u1:f1:r1:direct',
    );
    expect(
      buildCookSessionV3Key({ userId: 'u1', familyId: 'f1' }, 'r1', {
        kind: 'direct',
        date: '2026-07-12',
        mealType: 'dinner',
      }),
    ).toBe('culina-recipe-cook-session-v3:u1:f1:r1:direct:2026-07-12:dinner');
    expect(
      buildCookSessionV3Key({ userId: 'u1', familyId: 'f2' }, 'r1', { kind: 'plan', foodPlanItemId: 'p1' }),
    ).toBe('culina-recipe-cook-session-v3:u1:f2:r1:plan:p1');
    expect(buildActiveCookDescriptorKey(SCOPE)).toBe('culina-active-cook-v1:u1:f1');
    expect(buildLegacyCookSessionV2Key('r1')).toBe('culina-recipe-cook-session:r1:direct');
    expect(buildLegacyCookSessionV2Key('r1', 'p1')).toBe('culina-recipe-cook-session:r1:plan:p1');
    expect(buildLegacyCookSessionV1Key('r1')).toBe('culina-recipe-cook-session:r1');
  });
});

describe('readCookSessionV3', () => {
  const CURRENT_KEY = buildCookSessionV3Key(SCOPE, 'r1', { kind: 'direct' });

  it('preserves an unknown future version without deleting storage', () => {
    const storage = memoryStorage({ [CURRENT_KEY]: JSON.stringify({ version: 4, savedAt: NOW_ISO }) });
    expect(readCookSessionV3(storage, CURRENT_KEY)).toEqual({ kind: 'incompatible', version: 4 });
    expect(storage.getItem(CURRENT_KEY)).not.toBeNull();
  });

  it('returns ready for a valid unexpired v3 bundle', () => {
    const session = buildDefaultCookSessionV3(makeRecipe(), {
      source: 'direct',
      planItemId: null,
      completionRequestId: 'cook-stable-1',
    });
    const storage = memoryStorage({
      [CURRENT_KEY]: JSON.stringify({
        version: 3,
        savedAt: '2026-07-12T11:00:00.000Z',
        source: 'direct',
        planItemId: null,
        session,
      }),
    });
    const result = readCookSessionV3(storage, CURRENT_KEY, NOW);
    expect(result.kind).toBe('ready');
    if (result.kind === 'ready') {
      expect(result.bundle.session.completionRequestId).toBe('cook-stable-1');
    }
  });

  it('marks direct sessions expired after 24 hours', () => {
    const session = buildDefaultCookSessionV3(makeRecipe(), {
      source: 'direct',
      planItemId: null,
      completionRequestId: 'cook-1',
    });
    const storage = memoryStorage({
      [CURRENT_KEY]: JSON.stringify({
        version: 3,
        savedAt: '2026-07-11T11:59:00.000Z',
        source: 'direct',
        planItemId: null,
        session,
      }),
    });
    expect(readCookSessionV3(storage, CURRENT_KEY, NOW).kind).toBe('expired');
  });

  it('keeps plan sessions for 7 days and expires after', () => {
    const planKey = buildCookSessionV3Key(SCOPE, 'r1', { kind: 'plan', foodPlanItemId: 'p1' });
    const session = buildDefaultCookSessionV3(makeRecipe(), {
      source: 'plan',
      planItemId: 'p1',
      completionRequestId: 'cook-plan-1',
      planItemBaseUpdatedAt: '2026-07-01T00:00:00.000Z',
    });
    const within = memoryStorage({
      [planKey]: JSON.stringify({
        version: 3,
        savedAt: '2026-07-05T12:00:00.000Z',
        source: 'plan',
        planItemId: 'p1',
        session,
      }),
    });
    expect(readCookSessionV3(within, planKey, NOW).kind).toBe('ready');

    const expired = memoryStorage({
      [planKey]: JSON.stringify({
        version: 3,
        savedAt: '2026-07-05T11:59:00.000Z',
        source: 'plan',
        planItemId: 'p1',
        session,
      }),
    });
    // 7 days before NOW is 2026-07-05T12:00:00Z; 11:59 is older than 7d
    expect(readCookSessionV3(expired, planKey, NOW).kind).toBe('expired');
  });

  it('reports invalid for malformed v3 without deleting', () => {
    const storage = memoryStorage({
      [CURRENT_KEY]: JSON.stringify({ version: 3, savedAt: NOW_ISO, source: 'direct', planItemId: null }),
    });
    expect(readCookSessionV3(storage, CURRENT_KEY).kind).toBe('invalid');
    expect(storage.getItem(CURRENT_KEY)).not.toBeNull();
  });
});

describe('active cook descriptor compare-delete', () => {
  const DESCRIPTOR_KEY = buildActiveCookDescriptorKey(SCOPE);

  it('does not clear a newer descriptor from a stale tab', () => {
    const old = descriptor('recipe-old', null, '2026-07-12T08:00:00Z');
    const newer = descriptor('recipe-new', null, '2026-07-12T09:00:00Z');
    const storage = memoryStorage({ [DESCRIPTOR_KEY]: JSON.stringify(newer) });
    expect(compareAndClearActiveCook(storage, SCOPE, old)).toBe(false);
    expect(readActiveCook(storage, SCOPE)).toEqual(newer);
  });

  it('clears only when the expected descriptor still matches', () => {
    const current = descriptor('recipe-1', null, '2026-07-12T08:00:00Z');
    const storage = memoryStorage({ [DESCRIPTOR_KEY]: JSON.stringify(current) });
    expect(compareAndClearActiveCook(storage, SCOPE, current)).toBe(true);
    expect(readActiveCook(storage, SCOPE)).toBeNull();
  });

  it('compareAndClearCookSession leaves a newer session/descriptor intact', () => {
    const oldDesc = descriptor('recipe-old', null, '2026-07-12T08:00:00Z');
    const newerDesc = descriptor('recipe-new', null, '2026-07-12T09:00:00Z');
    const oldKey = buildCookSessionV3Key(SCOPE, 'recipe-old', { kind: 'direct' });
    const newKey = buildCookSessionV3Key(SCOPE, 'recipe-new', { kind: 'direct' });
    const oldSession = buildDefaultCookSessionV3(makeRecipe({ id: 'recipe-old' }), {
      source: 'direct',
      planItemId: null,
      completionRequestId: 'cook-old',
    });
    const newSession = buildDefaultCookSessionV3(makeRecipe({ id: 'recipe-new' }), {
      source: 'direct',
      planItemId: null,
      completionRequestId: 'cook-new',
    });
    const storage = memoryStorage({
      [buildActiveCookDescriptorKey(SCOPE)]: JSON.stringify(newerDesc),
      [oldKey]: JSON.stringify({
        version: 3,
        savedAt: oldDesc.savedAt,
        source: 'direct',
        planItemId: null,
        session: oldSession,
      }),
      [newKey]: JSON.stringify({
        version: 3,
        savedAt: newerDesc.savedAt,
        source: 'direct',
        planItemId: null,
        session: newSession,
      }),
    });

    expect(
      compareAndClearCookSession({
        storage,
        scope: SCOPE,
        expectedDescriptor: oldDesc,
        expectedSessionKey: oldKey,
      }),
    ).toBe(true);
    expect(readActiveCook(storage, SCOPE)).toEqual(newerDesc);
    expect(storage.getItem(oldKey)).toBeNull();
    expect(storage.getItem(newKey)).not.toBeNull();
  });
});

describe('legacy parser and migration', () => {
  it('raw old-key parser never sees v3 as legacy', () => {
    expect(
      parseLegacyCookSession({
        version: 3,
        savedAt: NOW_ISO,
        source: 'direct',
        planItemId: null,
        session: { completionRequestId: 'cook-1', source: 'direct' },
      }),
    ).toBeNull();
    expect(parseLegacyCookSession({ version: 4, savedAt: NOW_ISO })).toBeNull();
  });

  it('migrates only the exact verified legacy key once and creates a stable completion ID', () => {
    const input = makeVerifiedMigrationInput();
    const migrated = loadOrMigrateCookSession(input);
    expect(migrated.migrated).toBe(true);
    expect(migrated.session.completionRequestId).toMatch(/^cook-/);
    expect(migrated.session.checkedIngredientIds).toEqual(['ri-1']);
    expect(migrated.session.adjustments).toBe('少油');
    // createMealLog ignored — not present on V3 session
    expect('createMealLog' in migrated.session).toBe(false);

    const again = loadOrMigrateCookSession(input);
    expect(again.session.completionRequestId).toBe(migrated.session.completionRequestId);
    expect(again.migrated).toBe(false);
    expect(again.restored).toBe(true);
  });

  it('moves a scoped direct session into its date and meal key', () => {
    const recipe = makeRecipe();
    const legacyScopedKey = buildCookSessionV3Key(SCOPE, recipe.id, { kind: 'direct' });
    const targetKey = buildCookSessionV3Key(SCOPE, recipe.id, {
      kind: 'direct',
      date: '2026-07-12',
      mealType: 'dinner',
    });
    const session = buildDefaultCookSessionV3(recipe, {
      source: 'direct',
      planItemId: null,
      completionRequestId: 'cook-scoped-direct',
      date: '2026-07-12',
      mealType: 'dinner',
    });
    const storage = memoryStorage({
      [legacyScopedKey]: JSON.stringify({
        version: 3,
        savedAt: '2026-07-12T11:00:00.000Z',
        source: 'direct',
        planItemId: null,
        session,
      }),
    });

    const loaded = loadOrMigrateCookSession({
      storage,
      scope: SCOPE,
      recipe,
      foodId: 'food-1',
      source: { kind: 'direct', date: '2026-07-12', mealType: 'dinner' },
      ownershipVerified: true,
      now: NOW,
    });

    expect(loaded.restored).toBe(true);
    expect(loaded.migrated).toBe(true);
    expect(loaded.session.completionRequestId).toBe('cook-scoped-direct');
    expect(storage.getItem(legacyScopedKey)).toBeNull();
    expect(storage.getItem(targetKey)).not.toBeNull();
  });

  it('never overwrites an existing v3 session during migration', () => {
    const recipe = makeRecipe();
    const sessionKey = buildCookSessionV3Key(SCOPE, recipe.id, { kind: 'direct' });
    const existing = buildDefaultCookSessionV3(recipe, {
      source: 'direct',
      planItemId: null,
      completionRequestId: 'cook-existing',
    });
    const storage = memoryStorage({
      [sessionKey]: JSON.stringify({
        version: 3,
        savedAt: '2026-07-12T11:00:00.000Z',
        source: 'direct',
        planItemId: null,
        session: existing,
      }),
      [buildLegacyCookSessionV2Key(recipe.id)]: JSON.stringify({
        version: 2,
        savedAt: '2026-07-12T10:00:00.000Z',
        source: 'direct',
        planItemId: null,
        session: { currentStepIndex: 1, createMealLog: false },
      }),
    });

    const loaded = loadOrMigrateCookSession({
      storage,
      scope: SCOPE,
      recipe,
      foodId: 'food-1',
      source: { kind: 'direct' },
      ownershipVerified: true,
      now: NOW,
    });

    expect(loaded.restored).toBe(true);
    expect(loaded.migrated).toBe(false);
    expect(loaded.session.completionRequestId).toBe('cook-existing');
    expect(storage.getItem(buildLegacyCookSessionV2Key(recipe.id))).not.toBeNull();
  });

  it('preserves other user and family namespaces', () => {
    const recipe = makeRecipe();
    const otherUserKey = buildCookSessionV3Key(OTHER_SCOPE, recipe.id, { kind: 'direct' });
    const otherFamilyKey = buildCookSessionV3Key(OTHER_FAMILY, recipe.id, { kind: 'direct' });
    const session = buildDefaultCookSessionV3(recipe, {
      source: 'direct',
      planItemId: null,
      completionRequestId: 'cook-other',
    });
    const storage = memoryStorage({
      [otherUserKey]: JSON.stringify({
        version: 3,
        savedAt: NOW_ISO,
        source: 'direct',
        planItemId: null,
        session,
      }),
      [otherFamilyKey]: JSON.stringify({
        version: 3,
        savedAt: NOW_ISO,
        source: 'direct',
        planItemId: null,
        session,
      }),
      [buildActiveCookDescriptorKey(OTHER_SCOPE)]: JSON.stringify(descriptor(recipe.id, null, NOW_ISO)),
      [buildActiveCookDescriptorKey(OTHER_FAMILY)]: JSON.stringify(descriptor(recipe.id, null, NOW_ISO)),
    });

    loadOrMigrateCookSession({
      storage,
      scope: SCOPE,
      recipe,
      foodId: 'food-1',
      source: { kind: 'direct' },
      ownershipVerified: true,
      now: NOW,
      launch: { date: '2026-07-12', mealType: 'lunch', servings: 3 },
    });

    expect(storage.getItem(otherUserKey)).not.toBeNull();
    expect(storage.getItem(otherFamilyKey)).not.toBeNull();
    expect(readActiveCook(storage, OTHER_SCOPE)?.recipeId).toBe(recipe.id);
    expect(readActiveCook(storage, OTHER_FAMILY)?.recipeId).toBe(recipe.id);
  });

  it('does not migrate without ownership verification', () => {
    const recipe = makeRecipe();
    const legacyKey = buildLegacyCookSessionV2Key(recipe.id);
    const storage = memoryStorage({
      [legacyKey]: JSON.stringify({
        version: 2,
        savedAt: '2026-07-12T11:00:00.000Z',
        source: 'direct',
        planItemId: null,
        session: { currentStepIndex: 1, checkedIngredientIds: ['x'] },
      }),
    });

    const loaded = loadOrMigrateCookSession({
      storage,
      scope: SCOPE,
      recipe,
      foodId: 'food-1',
      source: { kind: 'direct' },
      ownershipVerified: false,
      now: NOW,
    });

    expect(loaded.migrated).toBe(false);
    expect(loaded.restored).toBe(false);
    expect(storage.getItem(legacyKey)).not.toBeNull();
  });

  it('explicit abandon clears only matching current-scope keys', () => {
    const recipe = makeRecipe();
    const session = buildDefaultCookSessionV3(recipe, {
      source: 'direct',
      planItemId: null,
      completionRequestId: 'cook-abandon',
    });
    const storage = memoryStorage();
    const desc = saveCookSessionV3({
      storage,
      scope: SCOPE,
      recipeId: recipe.id,
      session,
      savedAt: NOW_ISO,
    })!;
    const otherKey = buildCookSessionV3Key(OTHER_SCOPE, recipe.id, { kind: 'direct' });
    storage.setItem(
      otherKey,
      JSON.stringify({
        version: 3,
        savedAt: NOW_ISO,
        source: 'direct',
        planItemId: null,
        session,
      }),
    );

    const sessionKey = buildCookSessionV3Key(SCOPE, recipe.id, { kind: 'direct' });
    expect(
      compareAndClearCookSession({
        storage,
        scope: SCOPE,
        expectedDescriptor: desc,
        expectedSessionKey: sessionKey,
      }),
    ).toBe(true);
    expect(storage.getItem(sessionKey)).toBeNull();
    expect(readActiveCook(storage, SCOPE)).toBeNull();
    expect(storage.getItem(otherKey)).not.toBeNull();
  });

  it('current-scope 404 cleanup only removes matching keys', () => {
    const recipe = makeRecipe();
    const session = buildDefaultCookSessionV3(recipe, {
      source: 'plan',
      planItemId: 'p1',
      completionRequestId: 'cook-404',
      planItemBaseUpdatedAt: '2026-07-01T00:00:00.000Z',
    });
    const storage = memoryStorage();
    const desc = saveCookSessionV3({
      storage,
      scope: SCOPE,
      recipeId: recipe.id,
      session,
      savedAt: NOW_ISO,
    })!;
    const otherRecipeKey = buildCookSessionV3Key(SCOPE, 'r-other', { kind: 'direct' });
    storage.setItem(
      otherRecipeKey,
      JSON.stringify({
        version: 3,
        savedAt: NOW_ISO,
        source: 'direct',
        planItemId: null,
        session: buildDefaultCookSessionV3(makeRecipe({ id: 'r-other' }), {
          source: 'direct',
          planItemId: null,
          completionRequestId: 'cook-other-recipe',
        }),
      }),
    );

    compareAndClearCookSession({
      storage,
      scope: SCOPE,
      expectedDescriptor: desc,
      expectedSessionKey: buildCookSessionV3Key(SCOPE, recipe.id, { kind: 'plan', foodPlanItemId: 'p1' }),
    });

    expect(storage.getItem(otherRecipeKey)).not.toBeNull();
  });

  it('does not delete a newer same-key session when descriptor is missing mid-save', () => {
    const recipe = makeRecipe();
    const sessionKey = buildCookSessionV3Key(SCOPE, recipe.id, { kind: 'direct' });
    const olderDescriptor = descriptor(recipe.id, null, '2026-07-12T10:00:00.000Z');
    const newerSession = buildDefaultCookSessionV3(recipe, {
      source: 'direct',
      planItemId: null,
      completionRequestId: 'cook-newer-same-key',
    });
    const storage = memoryStorage({
      // Mid-save window: session rewritten with newer savedAt, descriptor not yet present.
      [sessionKey]: JSON.stringify({
        version: 3,
        savedAt: '2026-07-12T11:00:00.000Z',
        source: 'direct',
        planItemId: null,
        session: newerSession,
      }),
    });

    const cleared = compareAndClearCookSession({
      storage,
      scope: SCOPE,
      expectedDescriptor: olderDescriptor,
      expectedSessionKey: sessionKey,
    });

    expect(cleared).toBe(false);
    expect(storage.getItem(sessionKey)).not.toBeNull();
    expect(JSON.parse(storage.getItem(sessionKey)!).savedAt).toBe('2026-07-12T11:00:00.000Z');
  });
});

describe('save and default session', () => {
  it('writes v3 without createMealLog and updates the single active descriptor', () => {
    const storage = memoryStorage();
    const recipe = makeRecipe();
    const session = buildDefaultCookSessionV3(recipe, {
      source: 'direct',
      planItemId: null,
      completionRequestId: 'cook-save-1',
      date: '2026-07-12',
      mealType: 'dinner',
      servings: 2,
    });
    const desc = saveCookSessionV3({ storage, scope: SCOPE, recipeId: recipe.id, session, savedAt: NOW_ISO })!;
    const key = buildCookSessionV3Key(SCOPE, recipe.id, {
      kind: 'direct',
      date: '2026-07-12',
      mealType: 'dinner',
    });
    const raw = JSON.parse(storage.getItem(key)!);
    expect(raw.version).toBe(3);
    expect(raw.session.createMealLog).toBeUndefined();
    expect(raw.session.completionRequestId).toBe('cook-save-1');
    expect(desc).toEqual(descriptor(recipe.id, null, NOW_ISO));
    expect(readActiveCook(storage, SCOPE)).toEqual(desc);
  });

  it('does not auto-restore a descriptor into a cook task (descriptor is data only)', () => {
    // Active descriptor is a pointer; callers must resolve entities before opening Cook.
    const storage = memoryStorage();
    const desc = descriptor('missing-recipe', null, NOW_ISO);
    storage.setItem(buildActiveCookDescriptorKey(SCOPE), JSON.stringify(desc));
    expect(readActiveCook(storage, SCOPE)).toEqual(desc);
    // No side effect beyond read — storage unchanged, no task opened.
    expect(Object.keys(storage.data)).toEqual([buildActiveCookDescriptorKey(SCOPE)]);
  });
});
