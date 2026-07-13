import type { MealType, Recipe } from '../../api/types';
import type { StorageLike } from '../../lib/storage';
import { readJsonStorage, removeStorage, writeJsonStorage } from '../../lib/storage';
import { todayKey } from '../../lib/ui';
import {
  advanceCookTimers,
  clampStepIndex,
  getRecipeStepTitle,
  getStepSuggestedSeconds,
  newDraftId,
  type CookTimerState,
  type RecipeCookAssistantMessage,
  type RecipeCookSessionState,
} from './RecipeWorkspaceModel';
import { MEAL_TYPE_OPTIONS } from './RecipeWorkspaceOptions';

export type RecipeCookSessionScope = { userId: string; familyId: string };

export type RecipeCookSessionSource = 'direct' | 'plan';

export type RecipeCookSessionSourceRef =
  | { kind: 'direct' }
  | { kind: 'plan'; foodPlanItemId: string };

export type RecipeCookSessionStateV3 = Omit<RecipeCookSessionState, 'createMealLog'> & {
  completionRequestId: string;
  source: RecipeCookSessionSource;
  planItemId: string | null;
  planItemBaseUpdatedAt: string | null;
};

export type PersistedRecipeCookSessionV3 = {
  version: 3;
  savedAt: string;
  source: RecipeCookSessionSource;
  planItemId: string | null;
  session: RecipeCookSessionStateV3;
};

export type ActiveCookDescriptor = {
  version: 1;
  recipeId: string;
  foodPlanItemId: string | null;
  savedAt: string;
};

export type CookSessionReadResult =
  | { kind: 'missing' }
  | { kind: 'ready'; bundle: PersistedRecipeCookSessionV3 }
  | { kind: 'expired'; bundle: PersistedRecipeCookSessionV3 }
  | { kind: 'invalid' }
  | { kind: 'incompatible'; version: number | null };

export type LegacyCookSessionSourceRef =
  | { kind: 'direct' }
  | { kind: 'plan'; foodPlanItemId: string };

const DIRECT_COOK_SESSION_RETENTION_MS = 24 * 60 * 60 * 1000;
const PLAN_COOK_SESSION_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

function defaultStorage(): StorageLike {
  return localStorage;
}

export function buildCookSessionV3Key(
  scope: RecipeCookSessionScope,
  recipeId: string,
  source: RecipeCookSessionSourceRef,
): string {
  if (source.kind === 'plan') {
    return `culina-recipe-cook-session-v3:${scope.userId}:${scope.familyId}:${recipeId}:plan:${source.foodPlanItemId}`;
  }
  return `culina-recipe-cook-session-v3:${scope.userId}:${scope.familyId}:${recipeId}:direct`;
}

export function buildActiveCookDescriptorKey(scope: RecipeCookSessionScope): string {
  return `culina-active-cook-v1:${scope.userId}:${scope.familyId}`;
}

/** Exact legacy v2 key (unscoped). Distinct from v3. */
export function buildLegacyCookSessionV2Key(recipeId: string, planItemId: string | null = null): string {
  return planItemId
    ? `culina-recipe-cook-session:${recipeId}:plan:${planItemId}`
    : `culina-recipe-cook-session:${recipeId}:direct`;
}

/** Exact legacy v1 key (unscoped, no source suffix). */
export function buildLegacyCookSessionV1Key(recipeId: string): string {
  return `culina-recipe-cook-session:${recipeId}`;
}

export function newCompletionRequestId(): string {
  return newDraftId('cook');
}

export function buildDefaultCookSessionV3(
  recipe: Pick<Recipe, 'servings' | 'steps'>,
  args: {
    source: RecipeCookSessionSource;
    planItemId: string | null;
    planItemBaseUpdatedAt?: string | null;
    date?: string;
    mealType?: MealType;
    servings?: string | number;
    completionRequestId?: string;
  },
): RecipeCookSessionStateV3 {
  const firstStep = recipe.steps && recipe.steps[0];
  const firstStepSuggestedSeconds = firstStep ? getStepSuggestedSeconds(firstStep) : null;
  const isStepTimer = Boolean(firstStep && firstStepSuggestedSeconds);
  const planItemId = args.source === 'plan' ? args.planItemId : null;

  return {
    currentStepIndex: 0,
    checkedIngredientIds: [],
    completedStepIds: [],
    timers: [
      {
        id: 'default-timer',
        name: isStepTimer ? getRecipeStepTitle(firstStep, 0) : '自定义 1',
        seconds: 0,
        running: false,
        lastTickedAt: null,
        mode: firstStepSuggestedSeconds ? 'countdown' : 'countup',
        durationSeconds: firstStepSuggestedSeconds,
        source: isStepTimer ? 'step' : 'manual',
        stepId: isStepTimer ? firstStep.id : null,
      },
    ],
    activeTimerId: 'default-timer',
    servings: args.servings != null ? String(args.servings) : String(recipe.servings),
    date: args.date ?? todayKey(),
    mealType: args.mealType ?? 'dinner',
    planItemId,
    adjustments: '',
    resultNote: '',
    rating: '',
    aiAssistantMessages: [],
    completionRequestId: args.completionRequestId ?? newCompletionRequestId(),
    source: args.source,
    planItemBaseUpdatedAt: args.source === 'plan' ? args.planItemBaseUpdatedAt ?? null : null,
  };
}

export function sanitizeCookSessionV3(
  value: unknown,
  recipe: Pick<Recipe, 'servings' | 'steps'>,
  args: {
    source: RecipeCookSessionSource;
    planItemId: string | null;
    planItemBaseUpdatedAt?: string | null;
    completionRequestId?: string;
  },
): RecipeCookSessionStateV3 {
  const fallback = buildDefaultCookSessionV3(recipe, args);
  if (!value || typeof value !== 'object') return fallback;
  const parsed = value as Partial<RecipeCookSessionStateV3> & {
    createMealLog?: unknown;
    timerSeconds?: unknown;
    timerRunning?: unknown;
    timerMode?: unknown;
    timerDurationSeconds?: unknown;
  };

  function resolveLegacyStep(timer: { name?: unknown; stepId?: unknown }) {
    if (typeof timer.stepId === 'string') {
      return recipe.steps.find((step) => step.id === timer.stepId) ?? null;
    }
    if (typeof timer.name !== 'string') return null;
    return (
      recipe.steps.find((step, index) => {
        const title = getRecipeStepTitle(step, index);
        return timer.name === title || timer.name === `${title} 计时`;
      }) ?? null
    );
  }

  let timers: CookTimerState[] = Array.isArray(parsed.timers)
    ? parsed.timers.map((t: any, index): CookTimerState => {
        const legacyStep = resolveLegacyStep(t);
        const source =
          t.source === 'step' && legacyStep ? 'step' : t.source === 'manual' ? 'manual' : legacyStep ? 'step' : 'manual';
        return {
          id: typeof t.id === 'string' && t.id ? t.id : newDraftId('timer'),
          name:
            source === 'step' && legacyStep
              ? getRecipeStepTitle(legacyStep, recipe.steps.indexOf(legacyStep))
              : typeof t.name === 'string' && t.name
                ? t.name
                : `自定义 ${index + 1}`,
          seconds: Math.max(0, Number(t.seconds) || 0),
          running: Boolean(t.running),
          lastTickedAt: Number.isFinite(Number(t.lastTickedAt)) ? Number(t.lastTickedAt) : null,
          mode: t.mode === 'countdown' ? 'countdown' : 'countup',
          durationSeconds: Number(t.durationSeconds) > 0 ? Number(t.durationSeconds) : null,
          source,
          stepId: source === 'step' && legacyStep ? legacyStep.id : null,
        };
      })
    : [];

  if (timers.length === 0) {
    const currentStepIndex = clampStepIndex(Number(parsed.currentStepIndex) || 0, Math.max(recipe.steps.length, 1));
    const currentStep = recipe.steps[currentStepIndex] ?? null;
    const legacyDuration = Number(parsed.timerDurationSeconds) > 0 ? Number(parsed.timerDurationSeconds) : null;
    const isStepTimer = Boolean(currentStep && legacyDuration);
    timers = [
      {
        id: 'default-timer',
        name: isStepTimer ? getRecipeStepTitle(currentStep, currentStepIndex) : '自定义 1',
        seconds: Math.max(0, Number(parsed.timerSeconds) || 0),
        running: Boolean(parsed.timerRunning),
        lastTickedAt: null,
        mode: parsed.timerMode === 'countdown' ? 'countdown' : 'countup',
        durationSeconds: legacyDuration,
        source: isStepTimer ? 'step' : 'manual',
        stepId: isStepTimer ? currentStep.id : null,
      },
    ];
  }

  const activeTimerId =
    typeof parsed.activeTimerId === 'string' && timers.some((timer) => timer.id === parsed.activeTimerId)
      ? parsed.activeTimerId
      : timers[0].id;
  const advancedTimers = advanceCookTimers(timers);
  const planItemId = args.source === 'plan' ? args.planItemId : null;
  const completionRequestId =
    typeof parsed.completionRequestId === 'string' && parsed.completionRequestId.startsWith('cook-')
      ? parsed.completionRequestId
      : (args.completionRequestId ?? newCompletionRequestId());

  return {
    currentStepIndex: clampStepIndex(Number(parsed.currentStepIndex) || 0, Math.max(recipe.steps.length, 1)),
    checkedIngredientIds: Array.isArray(parsed.checkedIngredientIds)
      ? parsed.checkedIngredientIds.filter((item): item is string => typeof item === 'string')
      : [],
    completedStepIds: Array.isArray(parsed.completedStepIds)
      ? parsed.completedStepIds.filter((item): item is string => typeof item === 'string')
      : [],
    timers: advancedTimers.timers,
    activeTimerId: advancedTimers.newlyFinishedTimerId ?? activeTimerId,
    servings: typeof parsed.servings === 'string' && parsed.servings.trim() ? parsed.servings : fallback.servings,
    date: typeof parsed.date === 'string' && parsed.date ? parsed.date : fallback.date,
    mealType: MEAL_TYPE_OPTIONS.some((item) => item.value === parsed.mealType)
      ? (parsed.mealType as MealType)
      : fallback.mealType,
    planItemId,
    adjustments: typeof parsed.adjustments === 'string' ? parsed.adjustments : '',
    resultNote: typeof parsed.resultNote === 'string' ? parsed.resultNote : '',
    rating: typeof parsed.rating === 'string' ? parsed.rating : '',
    aiAssistantMessages: Array.isArray(parsed.aiAssistantMessages)
      ? parsed.aiAssistantMessages
          .filter(
            (item): item is RecipeCookAssistantMessage =>
              Boolean(
                item &&
                  typeof item === 'object' &&
                  typeof item.id === 'string' &&
                  typeof item.role === 'string' &&
                  typeof item.text === 'string',
              ),
          )
          .slice(-40)
      : [],
    completionRequestId,
    source: args.source,
    planItemBaseUpdatedAt:
      args.source === 'plan'
        ? typeof parsed.planItemBaseUpdatedAt === 'string'
          ? parsed.planItemBaseUpdatedAt
          : (args.planItemBaseUpdatedAt ?? null)
        : null,
  };
}

export function isCookSessionExpired(savedAt: string, source: RecipeCookSessionSource, now: number = Date.now()) {
  const savedAtMs = Date.parse(savedAt);
  if (!Number.isFinite(savedAtMs)) return true;
  const age = now - savedAtMs;
  if (age < 0) return false;
  const retentionMs = source === 'plan' ? PLAN_COOK_SESSION_RETENTION_MS : DIRECT_COOK_SESSION_RETENTION_MS;
  return age > retentionMs;
}

function isWellFormedV3Bundle(value: unknown): value is PersistedRecipeCookSessionV3 {
  if (!value || typeof value !== 'object') return false;
  const parsed = value as Partial<PersistedRecipeCookSessionV3>;
  if (parsed.version !== 3) return false;
  if (typeof parsed.savedAt !== 'string' || !parsed.savedAt) return false;
  if (parsed.source !== 'direct' && parsed.source !== 'plan') return false;
  if (parsed.planItemId !== null && typeof parsed.planItemId !== 'string') return false;
  if (!parsed.session || typeof parsed.session !== 'object') return false;
  const session = parsed.session as Partial<RecipeCookSessionStateV3>;
  if (typeof session.completionRequestId !== 'string' || !session.completionRequestId) return false;
  if (session.source !== 'direct' && session.source !== 'plan') return false;
  return true;
}

/**
 * Read a v3 session for an exact key. Never deletes future versions.
 * Malformed v3 for the exact key may be reported as invalid (caller decides cleanup).
 */
export function readCookSessionV3(
  storage: StorageLike,
  key: string,
  now: number = Date.now(),
): CookSessionReadResult {
  const raw = storage.getItem(key);
  if (raw == null) return { kind: 'missing' };

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kind: 'invalid' };
  }

  if (!parsed || typeof parsed !== 'object') return { kind: 'invalid' };
  const version = (parsed as { version?: unknown }).version;

  if (typeof version === 'number' && version > 3) {
    return { kind: 'incompatible', version };
  }
  if (version !== 3) {
    // Non-v3 at a v3 key is invalid for this namespace; never treat as legacy.
    return { kind: 'invalid' };
  }

  if (!isWellFormedV3Bundle(parsed)) {
    return { kind: 'invalid' };
  }

  if (isCookSessionExpired(parsed.savedAt, parsed.source, now)) {
    return { kind: 'expired', bundle: parsed };
  }

  return { kind: 'ready', bundle: parsed };
}

/**
 * Legacy v1/v2 parser for exact old keys only. Never interprets v3 payloads.
 */
export function parseLegacyCookSession(value: unknown): {
  version: 1 | 2;
  savedAt: string | null;
  source: RecipeCookSessionSource | null;
  planItemId: string | null;
  session: Record<string, unknown>;
} | null {
  if (!value || typeof value !== 'object') return null;
  const parsed = value as {
    version?: unknown;
    savedAt?: unknown;
    source?: unknown;
    planItemId?: unknown;
    session?: unknown;
    currentStepIndex?: unknown;
  };

  // Future / current v3 must never be treated as legacy.
  if (parsed.version === 3 || (typeof parsed.version === 'number' && parsed.version > 2)) {
    return null;
  }

  if (parsed.version === 2) {
    if (typeof parsed.savedAt !== 'string' || !parsed.savedAt) return null;
    if (parsed.source !== 'direct' && parsed.source !== 'plan') return null;
    if (parsed.planItemId !== null && typeof parsed.planItemId !== 'string') return null;
    if (!parsed.session || typeof parsed.session !== 'object') return null;
    return {
      version: 2,
      savedAt: parsed.savedAt,
      source: parsed.source,
      planItemId: parsed.planItemId ?? null,
      session: parsed.session as Record<string, unknown>,
    };
  }

  // v1 raw session blob (no version wrapper) or incomplete metadata.
  if (parsed.version != null && parsed.version !== 1) return null;
  if ('session' in parsed && parsed.session && typeof parsed.session === 'object') {
    return {
      version: 1,
      savedAt: typeof parsed.savedAt === 'string' ? parsed.savedAt : null,
      source: parsed.source === 'plan' || parsed.source === 'direct' ? parsed.source : null,
      planItemId: typeof parsed.planItemId === 'string' ? parsed.planItemId : null,
      session: parsed.session as Record<string, unknown>,
    };
  }

  if ('currentStepIndex' in parsed || 'checkedIngredientIds' in parsed || 'timers' in parsed) {
    return {
      version: 1,
      savedAt: typeof parsed.savedAt === 'string' ? parsed.savedAt : null,
      source: null,
      planItemId: typeof parsed.planItemId === 'string' ? parsed.planItemId : null,
      session: parsed as Record<string, unknown>,
    };
  }

  return null;
}

export function readActiveCook(storage: StorageLike, scope: RecipeCookSessionScope): ActiveCookDescriptor | null {
  const key = buildActiveCookDescriptorKey(scope);
  const value = readJsonStorage<unknown>(key, null, { clearOnError: false, storage });
  if (!value || typeof value !== 'object') return null;
  const parsed = value as Partial<ActiveCookDescriptor>;
  if (parsed.version !== 1) return null;
  if (typeof parsed.recipeId !== 'string' || !parsed.recipeId) return null;
  if (parsed.foodPlanItemId !== null && typeof parsed.foodPlanItemId !== 'string') return null;
  if (typeof parsed.savedAt !== 'string' || !parsed.savedAt) return null;
  return {
    version: 1,
    recipeId: parsed.recipeId,
    foodPlanItemId: parsed.foodPlanItemId ?? null,
    savedAt: parsed.savedAt,
  };
}

export function writeActiveCook(
  storage: StorageLike,
  scope: RecipeCookSessionScope,
  descriptor: ActiveCookDescriptor,
): void {
  writeJsonStorage(buildActiveCookDescriptorKey(scope), descriptor, storage);
}

export function saveCookSessionV3(args: {
  storage?: StorageLike;
  scope: RecipeCookSessionScope;
  recipeId: string;
  session: RecipeCookSessionStateV3;
  savedAt?: string;
  /** When true, refuse to overwrite an incompatible future version at the exact key. */
  refuseIncompatible?: boolean;
}): ActiveCookDescriptor | null {
  const storage = args.storage ?? defaultStorage();
  const sourceRef: RecipeCookSessionSourceRef =
    args.session.source === 'plan' && args.session.planItemId
      ? { kind: 'plan', foodPlanItemId: args.session.planItemId }
      : { kind: 'direct' };
  const sessionKey = buildCookSessionV3Key(args.scope, args.recipeId, sourceRef);
  if (args.refuseIncompatible !== false) {
    const existing = readCookSessionV3(storage, sessionKey);
    if (existing.kind === 'incompatible') {
      return null;
    }
  }
  const savedAt = args.savedAt ?? new Date().toISOString();
  const planItemId = sourceRef.kind === 'plan' ? sourceRef.foodPlanItemId : null;
  const sessionWithoutLegacy = { ...args.session } as RecipeCookSessionStateV3 & { createMealLog?: unknown };
  delete sessionWithoutLegacy.createMealLog;
  const bundle: PersistedRecipeCookSessionV3 = {
    version: 3,
    savedAt,
    source: sourceRef.kind,
    planItemId,
    session: {
      ...sessionWithoutLegacy,
      source: sourceRef.kind,
      planItemId,
    },
  };

  writeJsonStorage(sessionKey, bundle, storage);

  const descriptor: ActiveCookDescriptor = {
    version: 1,
    recipeId: args.recipeId,
    foodPlanItemId: planItemId,
    savedAt,
  };
  writeActiveCook(storage, args.scope, descriptor);
  return descriptor;
}

/**
 * Compare-before-delete for active descriptor. Only clears when storage still matches expected.
 */
export function compareAndClearActiveCook(
  storage: StorageLike,
  scope: RecipeCookSessionScope,
  expected: ActiveCookDescriptor,
): boolean {
  const current = readActiveCook(storage, scope);
  if (!current) return false;
  if (
    current.recipeId !== expected.recipeId ||
    current.foodPlanItemId !== expected.foodPlanItemId ||
    current.savedAt !== expected.savedAt
  ) {
    return false;
  }
  removeStorage(buildActiveCookDescriptorKey(scope), storage);
  return true;
}

/**
 * Compare-before-delete for both descriptor and exact session key.
 * Never scans storage; never touches other scopes/users/families.
 */
export function compareAndClearCookSession(args: {
  storage?: StorageLike;
  scope: RecipeCookSessionScope;
  expectedDescriptor: ActiveCookDescriptor;
  expectedSessionKey: string;
}): boolean {
  const storage = args.storage ?? defaultStorage();
  const clearedDescriptor = compareAndClearActiveCook(storage, args.scope, args.expectedDescriptor);

  const raw = storage.getItem(args.expectedSessionKey);
  if (raw == null) {
    return clearedDescriptor;
  }

  // Only clear the exact key if it still looks like our v3 session matching the descriptor.
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return clearedDescriptor;
  }

  if (!isWellFormedV3Bundle(parsed)) {
    // Future version at this exact key: leave it.
    if (parsed && typeof parsed === 'object' && typeof (parsed as { version?: unknown }).version === 'number') {
      const version = (parsed as { version: number }).version;
      if (version > 3) return clearedDescriptor;
    }
    // Malformed v3 at the exact expected key may be removed when descriptor matched or is already gone.
    if (clearedDescriptor || !readActiveCook(storage, args.scope)) {
      removeStorage(args.expectedSessionKey, storage);
      return true;
    }
    return clearedDescriptor;
  }

  if (
    parsed.session &&
    typeof parsed.session === 'object' &&
    // Ensure we only clear if session still corresponds to the descriptor target.
    true
  ) {
    const matchesTarget =
      args.expectedDescriptor.foodPlanItemId === parsed.planItemId ||
      (args.expectedDescriptor.foodPlanItemId == null && parsed.planItemId == null);
    // Session key already encodes recipe/source; clear only when descriptor compare succeeded
    // or the descriptor was already cleared and the session is for the same plan/direct target.
    if (clearedDescriptor || matchesTarget) {
      // Stale-tab protection: if a newer descriptor exists, do not clear session of another cook.
      const remaining = readActiveCook(storage, args.scope);
      if (remaining && remaining.savedAt !== args.expectedDescriptor.savedAt) {
        return clearedDescriptor;
      }
      removeStorage(args.expectedSessionKey, storage);
      return true;
    }
  }

  return clearedDescriptor;
}

export type LoadOrMigrateCookSessionInput = {
  storage?: StorageLike;
  scope: RecipeCookSessionScope;
  recipe: Pick<Recipe, 'id' | 'servings' | 'steps' | 'family_id'>;
  /** Caller-verified unique Food relation for this recipe (ownership already checked). */
  foodId: string;
  source: RecipeCookSessionSourceRef;
  planItemBaseUpdatedAt?: string | null;
  /** Optional launch seed used only when creating a brand-new session. */
  launch?: {
    date?: string;
    mealType?: MealType;
    servings?: string | number;
  };
  now?: number;
  /**
   * When true, caller has verified Recipe/Food/(optional plan) ownership for migration.
   * Migration never runs without this flag.
   */
  ownershipVerified: boolean;
};

export type LoadOrMigrateCookSessionResult = {
  session: RecipeCookSessionStateV3;
  restored: boolean;
  migrated: boolean;
  sessionKey: string;
  descriptor: ActiveCookDescriptor;
  readResult: CookSessionReadResult;
};

function sourceFromRef(source: RecipeCookSessionSourceRef): {
  source: RecipeCookSessionSource;
  planItemId: string | null;
} {
  if (source.kind === 'plan') {
    return { source: 'plan', planItemId: source.foodPlanItemId };
  }
  return { source: 'direct', planItemId: null };
}

/**
 * Load scoped v3 session. Migrates exact legacy v1/v2 key only when ownership is verified,
 * never overwrites existing v3, never enumerates storage, preserves completionRequestId.
 */
export function loadOrMigrateCookSession(input: LoadOrMigrateCookSessionInput): LoadOrMigrateCookSessionResult {
  const storage = input.storage ?? defaultStorage();
  const now = input.now ?? Date.now();
  const { source, planItemId } = sourceFromRef(input.source);
  const sessionKey = buildCookSessionV3Key(input.scope, input.recipe.id, input.source);
  const readResult = readCookSessionV3(storage, sessionKey, now);

  if (readResult.kind === 'incompatible') {
    // Preserve storage; return a fresh in-memory session that will not overwrite incompatible data
    // until the caller explicitly abandons (save path should refuse overwrite of incompatible).
    const session = buildDefaultCookSessionV3(input.recipe, {
      source,
      planItemId,
      planItemBaseUpdatedAt: input.planItemBaseUpdatedAt,
      date: input.launch?.date,
      mealType: input.launch?.mealType,
      servings: input.launch?.servings,
    });
    const descriptor: ActiveCookDescriptor = {
      version: 1,
      recipeId: input.recipe.id,
      foodPlanItemId: planItemId,
      savedAt: new Date(now).toISOString(),
    };
    return {
      session,
      restored: false,
      migrated: false,
      sessionKey,
      descriptor,
      readResult,
    };
  }

  if (readResult.kind === 'ready') {
    const session = sanitizeCookSessionV3(readResult.bundle.session, input.recipe, {
      source,
      planItemId,
      planItemBaseUpdatedAt:
        input.planItemBaseUpdatedAt ?? readResult.bundle.session.planItemBaseUpdatedAt ?? null,
      completionRequestId: readResult.bundle.session.completionRequestId,
    });
    const descriptor: ActiveCookDescriptor = {
      version: 1,
      recipeId: input.recipe.id,
      foodPlanItemId: planItemId,
      savedAt: readResult.bundle.savedAt,
    };
    // Ensure descriptor points at this session without clobbering a newer unrelated descriptor's savedAt
    // only when it already matches this target; otherwise caller handles collision UI.
    return {
      session,
      restored: true,
      migrated: false,
      sessionKey,
      descriptor,
      readResult,
    };
  }

  if (readResult.kind === 'expired') {
    // Leave cleanup to compare-and-clear with the known key; do not silent-delete here if a newer
    // descriptor exists. For exact-key expiry with no newer activity, remove the expired bundle.
    const active = readActiveCook(storage, input.scope);
    const expiredMatchesActive =
      active &&
      active.recipeId === input.recipe.id &&
      active.foodPlanItemId === planItemId &&
      active.savedAt === readResult.bundle.savedAt;
    if (expiredMatchesActive || !active) {
      removeStorage(sessionKey, storage);
      if (expiredMatchesActive && active) {
        compareAndClearActiveCook(storage, input.scope, active);
      }
    }
  } else if (readResult.kind === 'invalid') {
    // Provably malformed v3 for the exact current key may be removed.
    removeStorage(sessionKey, storage);
  }

  // Existing v3 missing/expired/invalid: try one-way legacy migration from exact old keys only.
  if (input.ownershipVerified && input.recipe.family_id === input.scope.familyId) {
    const legacyKeys = [
      buildLegacyCookSessionV2Key(input.recipe.id, planItemId),
      ...(planItemId ? [] : [buildLegacyCookSessionV1Key(input.recipe.id)]),
    ];

    for (const legacyKey of legacyKeys) {
      const raw = storage.getItem(legacyKey);
      if (raw == null) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        continue;
      }
      // Never treat v3 as legacy.
      if (parsed && typeof parsed === 'object' && (parsed as { version?: unknown }).version === 3) {
        continue;
      }
      if (
        parsed &&
        typeof parsed === 'object' &&
        typeof (parsed as { version?: unknown }).version === 'number' &&
        ((parsed as { version: number }).version as number) > 2
      ) {
        continue;
      }

      const legacy = parseLegacyCookSession(parsed);
      if (!legacy) continue;

      const legacySource = legacy.source ?? source;
      const legacyPlanItemId = legacy.planItemId ?? planItemId;
      if (legacySource !== source) continue;
      if (legacyPlanItemId !== planItemId) continue;

      // v2 with savedAt: honor TTL; v1 without savedAt: do not restore (same as old behavior).
      if (legacy.version === 2 && legacy.savedAt && isCookSessionExpired(legacy.savedAt, legacySource, now)) {
        removeStorage(legacyKey, storage);
        continue;
      }
      if (legacy.version === 1 && !legacy.savedAt) {
        // Unmigratable v1 blob without metadata: drop the exact key after failed restore attempt.
        removeStorage(legacyKey, storage);
        continue;
      }

      // Re-check v3 still missing before write — never overwrite existing v3.
      const recheck = readCookSessionV3(storage, sessionKey, now);
      if (recheck.kind === 'ready' || recheck.kind === 'incompatible') {
        break;
      }

      const completionRequestId = newCompletionRequestId();
      const session = sanitizeCookSessionV3(legacy.session, input.recipe, {
        source,
        planItemId,
        planItemBaseUpdatedAt: input.planItemBaseUpdatedAt,
        completionRequestId,
      });
      // Ignore legacy createMealLog (already omitted by V3 type / sanitize).
      const descriptor = saveCookSessionV3({
        storage,
        scope: input.scope,
        recipeId: input.recipe.id,
        session,
        savedAt: legacy.savedAt && !isCookSessionExpired(legacy.savedAt, source, now)
          ? legacy.savedAt
          : new Date(now).toISOString(),
      });
      if (!descriptor) break;
      // Remove only the exact legacy key we migrated.
      removeStorage(legacyKey, storage);

      return {
        session,
        restored: true,
        migrated: true,
        sessionKey,
        descriptor,
        readResult: { kind: 'ready', bundle: { version: 3, savedAt: descriptor.savedAt, source, planItemId, session } },
      };
    }
  }

  const session = buildDefaultCookSessionV3(input.recipe, {
    source,
    planItemId,
    planItemBaseUpdatedAt: input.planItemBaseUpdatedAt,
    date: input.launch?.date,
    mealType: input.launch?.mealType,
    servings: input.launch?.servings,
  });
  const descriptor = saveCookSessionV3({
    storage,
    scope: input.scope,
    recipeId: input.recipe.id,
    session,
    savedAt: new Date(now).toISOString(),
  }) ?? {
    version: 1 as const,
    recipeId: input.recipe.id,
    foodPlanItemId: planItemId,
    savedAt: new Date(now).toISOString(),
  };

  return {
    session,
    restored: false,
    migrated: false,
    sessionKey,
    descriptor,
    readResult: { kind: 'missing' },
  };
}

export function descriptorsMatch(a: ActiveCookDescriptor | null, b: ActiveCookDescriptor | null): boolean {
  if (!a || !b) return false;
  return a.recipeId === b.recipeId && a.foodPlanItemId === b.foodPlanItemId && a.savedAt === b.savedAt;
}

export function isSameCookTarget(
  descriptor: ActiveCookDescriptor,
  recipeId: string,
  planItemId: string | null,
): boolean {
  return descriptor.recipeId === recipeId && descriptor.foodPlanItemId === planItemId;
}

/**
 * Runtime hybrid session for UI still using createMealLog until Task 24.
 * Persisted form is always V3 without createMealLog.
 */
export type RecipeCookSessionRuntime = RecipeCookSessionStateV3 & {
  createMealLog: boolean;
};

export function toRuntimeCookSession(session: RecipeCookSessionStateV3, createMealLog = true): RecipeCookSessionRuntime {
  return { ...session, createMealLog };
}

export function toPersistedCookSessionV3(session: RecipeCookSessionRuntime | RecipeCookSessionStateV3): RecipeCookSessionStateV3 {
  const {
    createMealLog: _ignored,
    ...rest
  } = session as RecipeCookSessionStateV3 & { createMealLog?: boolean };
  return rest;
}
