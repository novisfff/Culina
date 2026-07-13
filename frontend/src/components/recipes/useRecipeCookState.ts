import { useEffect, useRef, useState, type FormEvent } from 'react';
import type {
  CookRecipePreviewRequest,
  CookRecipePreviewResponse,
  CookRecipeRequest,
  CookRecipeResponse,
} from '../../api/types';
import type { CookLaunchContext } from '../../app/appNavigationModel';
import {
  advanceCookTimers,
  buildCookPayload,
  buildCookPreviewPayload,
  buildDefaultCookSession,
  clampStepIndex,
  clearCookSession,
  getNextManualTimerName,
  getCookCompletionMessage,
  getStepSuggestedSeconds,
  handleCookResult,
  loadCookSession,
  removeCookTimer,
  resolveErrorMessage,
  saveCookSession,
  transitionCookTimerForStep,
  type RecipeCookAssistantMessage,
  type RecipeCookSessionState,
  type RecipeNotice,
} from './RecipeWorkspaceModel';
import {
  buildCookSessionV3Key,
  compareAndClearCookSession,
  isSameCookTarget,
  loadOrMigrateCookSession,
  readActiveCook,
  saveCookSessionV3,
  toPersistedCookSessionV3,
  toRuntimeCookSession,
  type ActiveCookDescriptor,
  type RecipeCookSessionRuntime,
  type RecipeCookSessionScope,
  type RecipeCookSessionSourceRef,
} from './recipeCookSessionStorage';
import type { RecipeCardViewModel, RecipeWorkspaceView } from './workspaceModel';

export type RecipeCookReturnTarget = 'home' | 'foods' | 'recipes';
export type RecipeCookExitTarget = 'detail' | 'library' | 'source';

export type CookSessionCollision = {
  existing: ActiveCookDescriptor;
  pendingCard: RecipeCardViewModel;
  pendingPlanItemId: string | null;
  pendingReturnTarget: RecipeCookReturnTarget | null;
  pendingLaunch: CookLaunchContext | null;
};

function sourceRefFromPlanItemId(planItemId: string | null): RecipeCookSessionSourceRef {
  return planItemId ? { kind: 'plan', foodPlanItemId: planItemId } : { kind: 'direct' };
}

function planItemBaseFromLaunch(launch: CookLaunchContext | null | undefined, planItemId: string | null): string | null {
  if (!planItemId || !launch || launch.source.kind !== 'plan') return null;
  return launch.source.planItemBaseUpdatedAt || null;
}

function resolveCompletionRequestId(
  session: RecipeCookSessionState | RecipeCookSessionRuntime,
  recipeId: string,
): string {
  if ('completionRequestId' in session && typeof session.completionRequestId === 'string' && session.completionRequestId) {
    return session.completionRequestId;
  }
  return `cook-legacy-${recipeId}`;
}

function resolvePlanItemBaseUpdatedAt(
  session: RecipeCookSessionState | RecipeCookSessionRuntime,
): string | null {
  if ('planItemBaseUpdatedAt' in session && typeof session.planItemBaseUpdatedAt === 'string' && session.planItemBaseUpdatedAt) {
    return session.planItemBaseUpdatedAt;
  }
  return null;
}

export function useRecipeCookState(args: {
  cards: RecipeCardViewModel[];
  selectedCard: RecipeCardViewModel | null;
  view: RecipeWorkspaceView;
  setView: (view: RecipeWorkspaceView) => void;
  setSelectedRecipeId: (recipeId: string | null) => void;
  startRecipeId?: string | null;
  startFoodPlanItemId?: string | null;
  startRecipeReturnTarget?: RecipeCookReturnTarget | null;
  onStartRecipeHandled?: () => void;
  onCookReturnToSource?: (target: RecipeCookReturnTarget) => void;
  previewCookRecipe: (recipeId: string, payload: CookRecipePreviewRequest) => Promise<CookRecipePreviewResponse>;
  cookRecipe: (recipeId: string, payload: CookRecipeRequest) => Promise<CookRecipeResponse>;
  isCookingRecipe?: boolean;
  showRecipeNotice: (notice: RecipeNotice) => void;
  /** Authenticated scope for v3 persistence. When absent, falls back to unscoped v2. */
  sessionScope?: RecipeCookSessionScope | null;
  launchContext?: CookLaunchContext | null;
  /** Caller-verified unique Food id for the active recipe (required for legacy migration). */
  foodId?: string | null;
  ownershipVerified?: boolean;
  /** Navigate to the exact meal log created by this cook. */
  onViewMealLog?: (mealLogId: string) => void;
  /** Called after a successful complete cook when the user dismisses without viewing the meal. */
  onCookFinished?: () => void;
}) {
  const cookTimerMinuteWheelRef = useRef<HTMLDivElement | null>(null);
  const cookTimerSecondWheelRef = useRef<HTMLDivElement | null>(null);
  const previewCookRecipeRef = useRef(args.previewCookRecipe);
  const descriptorAtSessionStartRef = useRef<ActiveCookDescriptor | null>(null);
  const sessionKeyAtStartRef = useRef<string | null>(null);
  /** Blocks autosave immediately after a successful complete, before React state catches up. */
  const completionLockedRef = useRef(false);

  const [cookCard, setCookCard] = useState<RecipeCardViewModel | null>(null);
  const [cookPreview, setCookPreview] = useState<CookRecipePreviewResponse | null>(null);
  const [cookPreviewError, setCookPreviewError] = useState<string | null>(null);
  const [isCookPreviewLoading, setIsCookPreviewLoading] = useState(false);
  const [cookSession, setCookSession] = useState<RecipeCookSessionState | RecipeCookSessionRuntime | null>(null);
  const [wasCookSessionRestored, setWasCookSessionRestored] = useState(false);
  const [isCookFinishOpen, setIsCookFinishOpen] = useState(false);
  const [isCookTimerCustomOpen, setIsCookTimerCustomOpen] = useState(false);
  const [cookTimerPicker, setCookTimerPicker] = useState({ minutes: 2, seconds: 0 });
  const [cookTimerJustStarted, setCookTimerJustStarted] = useState(false);
  const [cookReturnTarget, setCookReturnTarget] = useState<RecipeCookReturnTarget | null>(null);
  const [cookCollision, setCookCollision] = useState<CookSessionCollision | null>(null);
  const [cookFinishStatusMessage, setCookFinishStatusMessage] = useState<string | null>(null);
  const [cookCompletionResult, setCookCompletionResult] = useState<{
    mealLogId: string;
    cookLogId: string;
    message: string;
    recipeTitle: string;
  } | null>(null);

  const activeCookCard = cookCard ?? (args.view === 'cook' ? args.selectedCard : null);
  const cookSteps = activeCookCard?.recipe.steps.length
    ? activeCookCard.recipe.steps
    : activeCookCard
      ? [{ id: 'fallback-step', title: '', text: '这份菜谱还没有录入步骤，可以先按你的习惯完成烹饪。', icon: 'tip', summary: '', estimated_minutes: null, tip: '', key_points: [] }]
      : [];
  const currentCookStep = cookSteps[clampStepIndex(cookSession?.currentStepIndex ?? 0, Math.max(cookSteps.length, 1))] ?? null;
  const currentStepSuggestedSeconds = getStepSuggestedSeconds(currentCookStep);
  const activeTimer = cookSession?.timers.find((t) => t.id === cookSession.activeTimerId) ?? cookSession?.timers[0] ?? null;
  const cookTimerDisplaySeconds = activeTimer
    ? activeTimer.mode === 'countdown'
      ? Math.max((activeTimer.durationSeconds ?? 0) - activeTimer.seconds, 0)
      : activeTimer.seconds
    : 0;
  const cookTimerDurationSeconds = activeTimer?.durationSeconds ?? null;
  const cookTimerProgress = activeTimer && activeTimer.mode === 'countdown' && activeTimer.durationSeconds
    ? Math.min(Math.max(activeTimer.seconds / activeTimer.durationSeconds, 0), 1)
    : 0;
  const cookProgressPercent = cookSteps.length > 0 ? Math.round((((cookSession?.currentStepIndex ?? 0) + 1) / cookSteps.length) * 100) : 0;
  const cookSubmitDisabled =
    args.isCookingRecipe || isCookPreviewLoading || Boolean(cookPreviewError) || !cookPreview || !cookSession;

  useEffect(() => {
    previewCookRecipeRef.current = args.previewCookRecipe;
  }, [args.previewCookRecipe]);

  useEffect(() => {
    if (!activeCookCard || !cookSession) {
      setCookPreview(null);
      setCookPreviewError(null);
      setIsCookPreviewLoading(false);
      return;
    }
    if (!Number.isFinite(Number(cookSession.servings)) || Number(cookSession.servings) <= 0) {
      setCookPreview(null);
      setCookPreviewError('份量必须大于 0。');
      setIsCookPreviewLoading(false);
      return;
    }

    let ignore = false;
    setIsCookPreviewLoading(true);
    setCookPreviewError(null);
    const payload = buildCookPreviewPayload({
      servings: cookSession.servings,
      allowPartialInventoryDeduction: true,
    });
    const timer = window.setTimeout(() => {
      previewCookRecipeRef.current(activeCookCard.recipe.id, payload)
        .then((response) => {
          if (ignore) return;
          setCookPreview(response);
          setCookPreviewError(null);
        })
        .catch((reason) => {
          if (ignore) return;
          setCookPreview(null);
          setCookPreviewError(resolveErrorMessage(reason, '扣减预览失败'));
        })
        .finally(() => {
          if (!ignore) {
            setIsCookPreviewLoading(false);
          }
        });
    }, 250);

    return () => {
      ignore = true;
      window.clearTimeout(timer);
    };
  }, [activeCookCard?.recipe.id, cookSession?.servings]);

  useEffect(() => {
    if (args.view !== 'cook' || !activeCookCard || !cookSession) return;
    // After a successful complete, never rewrite the cleared session/descriptor.
    if (completionLockedRef.current || cookCompletionResult) return;
    const scope = args.sessionScope;
    if (scope) {
      const runtime = cookSession as RecipeCookSessionRuntime;
      const persisted = toPersistedCookSessionV3({
        ...runtime,
        completionRequestId:
          'completionRequestId' in runtime && typeof runtime.completionRequestId === 'string'
            ? runtime.completionRequestId
            : `cook-missing-${activeCookCard.recipe.id}`,
        source:
          'source' in runtime && (runtime.source === 'plan' || runtime.source === 'direct')
            ? runtime.source
            : runtime.planItemId
              ? 'plan'
              : 'direct',
        planItemBaseUpdatedAt:
          'planItemBaseUpdatedAt' in runtime ? (runtime.planItemBaseUpdatedAt as string | null) : null,
      });
      const descriptor = saveCookSessionV3({
        scope,
        recipeId: activeCookCard.recipe.id,
        session: persisted,
      });
      if (descriptor) {
        descriptorAtSessionStartRef.current = descriptor;
        sessionKeyAtStartRef.current = buildCookSessionV3Key(
          scope,
          activeCookCard.recipe.id,
          sourceRefFromPlanItemId(persisted.planItemId),
        );
      }
      return;
    }
    saveCookSession(activeCookCard.recipe.id, cookSession as RecipeCookSessionState);
  }, [args.view, activeCookCard, cookSession, args.sessionScope, cookCompletionResult]);

  useEffect(() => {
    if (args.view !== 'cook' || !cookSession) return;
    if (completionLockedRef.current || cookCompletionResult) return;
    const hasRunningTimer = cookSession.timers.some((t) => t.running);
    if (!hasRunningTimer) return;
    const timer = window.setInterval(() => {
      setCookSession((current) => {
        if (!current || completionLockedRef.current) return current;
        const { timers, newlyFinishedTimerId } = advanceCookTimers(current.timers);
        return { ...current, timers, activeTimerId: newlyFinishedTimerId ?? current.activeTimerId };
      });
    }, 1000);
    return () => window.clearInterval(timer);
  }, [args.view, cookSession?.timers.some((t) => t.running), cookCompletionResult]);

  useEffect(() => {
    if (!cookTimerJustStarted) return;
    const timer = window.setTimeout(() => setCookTimerJustStarted(false), 700);
    return () => window.clearTimeout(timer);
  }, [cookTimerJustStarted]);

  useEffect(() => {
    if (!isCookTimerCustomOpen) return;
    window.requestAnimationFrame(() => {
      cookTimerMinuteWheelRef.current?.scrollTo({ top: Math.max(cookTimerPicker.minutes * 38 - 52, 0), behavior: 'auto' });
      cookTimerSecondWheelRef.current?.scrollTo({ top: Math.max(cookTimerPicker.seconds * 38 - 52, 0), behavior: 'auto' });
    });
  }, [isCookTimerCustomOpen, cookTimerPicker.minutes, cookTimerPicker.seconds]);

  function beginCookSession(argsOpen: {
    card: RecipeCardViewModel;
    planItemId: string | null;
    returnTarget?: RecipeCookReturnTarget | null;
    launch?: CookLaunchContext | null;
    forceNew?: boolean;
  }) {
    const { card, planItemId, returnTarget, launch, forceNew } = argsOpen;
    const scope = args.sessionScope;

    if (scope) {
      if (forceNew) {
        const active = readActiveCook(localStorage, scope);
        if (active) {
          const activeKey = buildCookSessionV3Key(
            scope,
            active.recipeId,
            active.foodPlanItemId ? { kind: 'plan', foodPlanItemId: active.foodPlanItemId } : { kind: 'direct' },
          );
          compareAndClearCookSession({
            scope,
            expectedDescriptor: active,
            expectedSessionKey: activeKey,
          });
        }
      } else {
        const active = readActiveCook(localStorage, scope);
        if (active && !isSameCookTarget(active, card.recipe.id, planItemId)) {
          setCookCollision({
            existing: active,
            pendingCard: card,
            pendingPlanItemId: planItemId,
            pendingReturnTarget: returnTarget ?? null,
            pendingLaunch: launch ?? null,
          });
          return;
        }
      }

      const source = sourceRefFromPlanItemId(planItemId);
      const loaded = loadOrMigrateCookSession({
        scope,
        recipe: card.recipe,
        foodId: args.foodId ?? '',
        source,
        planItemBaseUpdatedAt: planItemBaseFromLaunch(launch, planItemId),
        ownershipVerified: Boolean(args.ownershipVerified && args.foodId),
        launch:
          forceNew || !launch
            ? launch
              ? { date: launch.date, mealType: launch.mealType, servings: launch.servings }
              : undefined
            : { date: launch.date, mealType: launch.mealType, servings: launch.servings },
      });

      // Restored sessions keep date/meal/servings/timers/feedback/request ID.
      // New sessions may already be seeded via launch in loadOrMigrate.
      const runtime = toRuntimeCookSession(loaded.session);
      descriptorAtSessionStartRef.current = loaded.descriptor;
      sessionKeyAtStartRef.current = loaded.sessionKey;

      args.setSelectedRecipeId(card.recipe.id);
      setCookCard(card);
      setCookReturnTarget(returnTarget ?? null);
      completionLockedRef.current = false;
      setCookSession(runtime);
      setWasCookSessionRestored(loaded.restored);
      setIsCookFinishOpen(false);
      setCookFinishStatusMessage(null);
      setCookCompletionResult(null);
      setCookPreview(null);
      setCookPreviewError(null);
      setCookCollision(null);
      args.setView('cook');
      window.requestAnimationFrame(() => {
        window.scrollTo({ top: 0, left: 0, behavior: 'auto' });
      });
      return;
    }

    const loaded = loadCookSession(card.recipe, planItemId);
    args.setSelectedRecipeId(card.recipe.id);
    setCookCard(card);
    setCookReturnTarget(returnTarget ?? null);
    setCookSession(loaded.session);
    setWasCookSessionRestored(loaded.restored);
    setIsCookFinishOpen(false);
    setCookPreview(null);
    setCookPreviewError(null);
    args.setView('cook');
    window.requestAnimationFrame(() => {
      window.scrollTo({ top: 0, left: 0, behavior: 'auto' });
    });
  }

  function openCook(card: RecipeCardViewModel, planItemId?: string, returnTarget?: RecipeCookReturnTarget | null) {
    beginCookSession({
      card,
      planItemId: planItemId ?? null,
      returnTarget: returnTarget ?? null,
      launch: args.launchContext ?? null,
    });
  }

  function continueExistingCook() {
    if (!cookCollision || !args.sessionScope) return;
    const existing = cookCollision.existing;
    const targetCard =
      args.cards.find((card) => card.recipe.id === existing.recipeId) ?? null;
    if (!targetCard) {
      args.showRecipeNotice({
        tone: 'warning',
        title: '无法继续上次做菜',
        message: '上次的菜谱当前不可用，可放弃后重新开始。',
      });
      return;
    }
    beginCookSession({
      card: targetCard,
      planItemId: existing.foodPlanItemId,
      returnTarget: cookCollision.pendingReturnTarget,
      launch: null,
    });
  }

  function abandonAndStartNewCook() {
    if (!cookCollision) return;
    beginCookSession({
      card: cookCollision.pendingCard,
      planItemId: cookCollision.pendingPlanItemId,
      returnTarget: cookCollision.pendingReturnTarget,
      launch: cookCollision.pendingLaunch,
      forceNew: true,
    });
  }

  function dismissCookCollision() {
    setCookCollision(null);
  }

  useEffect(() => {
    if (!args.startRecipeId) return;
    const targetCard = args.cards.find((card) => card.recipe.id === args.startRecipeId);
    if (!targetCard) return;
    beginCookSession({
      card: targetCard,
      planItemId: args.startFoodPlanItemId ?? null,
      returnTarget: args.startRecipeReturnTarget ?? null,
      launch: args.launchContext ?? null,
    });
    args.onStartRecipeHandled?.();
    // Intentionally only react to start ids; cards identity is resolved inside.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [args.cards, args.startFoodPlanItemId, args.startRecipeId, args.startRecipeReturnTarget]);

  function closeCookDialog() {
    setCookCard(null);
    setCookReturnTarget(null);
    setCookSession(null);
    setWasCookSessionRestored(false);
    setIsCookFinishOpen(false);
    setCookFinishStatusMessage(null);
    setCookCompletionResult(null);
    setCookPreview(null);
    setCookPreviewError(null);
    completionLockedRef.current = false;
    descriptorAtSessionStartRef.current = null;
    sessionKeyAtStartRef.current = null;
  }

  function pauseAllCookTimers(
    session: RecipeCookSessionState | RecipeCookSessionRuntime,
  ): RecipeCookSessionState | RecipeCookSessionRuntime {
    return {
      ...session,
      timers: session.timers.map((timer) => {
        const advanced = advanceCookTimers([timer]).timers[0] ?? timer;
        return { ...advanced, running: false, lastTickedAt: null };
      }),
    };
  }

  function updateCookSession(patch: Partial<RecipeCookSessionState | RecipeCookSessionRuntime>) {
    setCookSession((current) => (current ? { ...current, ...patch } : current));
  }

  function selectCookTimerDuration(seconds: number | null) {
    setCookSession((current) => {
      if (!current) return current;
      const nextTimers = current.timers.map((t) => {
        if (t.id !== current.activeTimerId) return t;
        return {
          ...t,
          mode: seconds ? ('countdown' as const) : ('countup' as const),
          durationSeconds: seconds,
          seconds: 0,
          running: false,
          lastTickedAt: null,
        };
      });
      return { ...current, timers: nextTimers };
    });
  }

  function openCustomCookTimer() {
    const duration = activeTimer?.durationSeconds ?? currentStepSuggestedSeconds ?? 120;
    setCookTimerPicker({
      minutes: Math.min(Math.floor(duration / 60), 59),
      seconds: duration % 60,
    });
    setIsCookTimerCustomOpen((current) => !current);
  }

  function confirmCustomCookTimer() {
    const duration = cookTimerPicker.minutes * 60 + cookTimerPicker.seconds;
    if (duration <= 0) return;
    setCookSession((current) => {
      if (!current) return current;
      const nextTimers = current.timers.map((t) => {
        if (t.id !== current.activeTimerId) return t;
        return {
          ...t,
          mode: 'countdown' as const,
          durationSeconds: duration,
          seconds: 0,
          running: true,
          lastTickedAt: Date.now(),
        };
      });
      return { ...current, timers: nextTimers };
    });
    setIsCookTimerCustomOpen(false);
    setCookTimerJustStarted(true);
  }

  function toggleCookTimer() {
    setCookSession((current) => {
      if (!current) return current;
      const nextTimers = current.timers.map((t) => {
        if (t.id !== current.activeTimerId) return t;
        if (t.running) {
          const advanced = advanceCookTimers([t]).timers[0] ?? t;
          return { ...advanced, running: false, lastTickedAt: null };
        } else {
          const duration = t.durationSeconds ?? (t.id === 'default-timer' ? currentStepSuggestedSeconds : null);
          return {
            ...t,
            mode: duration ? ('countdown' as const) : ('countup' as const),
            durationSeconds: duration,
            running: true,
            lastTickedAt: Date.now(),
          };
        }
      });
      return { ...current, timers: nextTimers };
    });
    setCookTimerJustStarted(true);
  }

  function resetCookTimer() {
    setCookSession((current) => {
      if (!current) return current;
      const nextTimers = current.timers.map((t) => {
        if (t.id !== current.activeTimerId) return t;
        return {
          ...t,
          seconds: 0,
          running: false,
          lastTickedAt: null,
        };
      });
      return { ...current, timers: nextTimers };
    });
  }

  function addCookTimerSeconds(seconds: number) {
    addTimerSecondsById(undefined, seconds);
  }

  function addTimer(mode: 'countup' | 'countdown', durationSeconds: number | null, name?: string) {
    setCookSession((current) => {
      if (!current) return current;
      const newId = `timer-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`;
      const timerName = name || getNextManualTimerName(current.timers);
      const newTimer = {
        id: newId,
        name: timerName,
        seconds: 0,
        running: false,
        lastTickedAt: null,
        mode,
        durationSeconds,
        source: 'manual' as const,
        stepId: null,
      };
      return {
        ...current,
        timers: [...current.timers, newTimer],
        activeTimerId: newId,
      };
    });
  }

  function startTimerById(id?: string) {
    setCookSession((current) => {
      if (!current) return current;
      const targetId = id && current.timers.some((timer) => timer.id === id) ? id : current.activeTimerId;
      const nextTimers = current.timers.map((t) => {
        if (t.id !== targetId) return t;
        const duration = t.durationSeconds ?? (t.id === current.activeTimerId ? currentStepSuggestedSeconds : null);
        return {
          ...t,
          mode: duration ? ('countdown' as const) : ('countup' as const),
          durationSeconds: duration,
          running: true,
          lastTickedAt: Date.now(),
        };
      });
      return { ...current, timers: nextTimers, activeTimerId: targetId };
    });
    setCookTimerJustStarted(true);
  }

  function pauseTimerById(id?: string) {
    setCookSession((current) => {
      if (!current) return current;
      const targetId = id && current.timers.some((timer) => timer.id === id) ? id : current.activeTimerId;
      const nextTimers = current.timers.map((t) => {
        if (t.id !== targetId) return t;
        const advanced = advanceCookTimers([t]).timers[0] ?? t;
        return { ...advanced, running: false, lastTickedAt: null };
      });
      return { ...current, timers: nextTimers, activeTimerId: targetId };
    });
  }

  function resetTimerById(id?: string) {
    setCookSession((current) => {
      if (!current) return current;
      const targetId = id && current.timers.some((timer) => timer.id === id) ? id : current.activeTimerId;
      const nextTimers = current.timers.map((t) => (t.id === targetId ? { ...t, seconds: 0, running: false, lastTickedAt: null } : t));
      return { ...current, timers: nextTimers, activeTimerId: targetId };
    });
  }

  function addTimerSecondsById(id: string | undefined, seconds: number) {
    setCookSession((current) => {
      if (!current || seconds === 0) return current;
      const targetId = id && current.timers.some((timer) => timer.id === id) ? id : current.activeTimerId;
      const nextTimers = current.timers.map((t) => {
        if (t.id !== targetId || t.mode !== 'countdown') return t;
        const duration = t.durationSeconds ?? 0;
        return {
          ...t,
          durationSeconds: Math.max(duration + seconds, seconds),
        };
      });
      return { ...current, timers: nextTimers, activeTimerId: targetId };
    });
  }

  function setTimerById(id: string | undefined, seconds: number, name?: string) {
    setCookSession((current) => {
      if (!current || seconds <= 0) return current;
      const targetId = id && current.timers.some((timer) => timer.id === id) ? id : current.activeTimerId;
      const nextTimers = current.timers.map((t) => {
        if (t.id !== targetId) return t;
        return {
          ...t,
          name: name?.trim() || t.name,
          mode: 'countdown' as const,
          durationSeconds: seconds,
          seconds: 0,
          running: true,
          lastTickedAt: Date.now(),
        };
      });
      return { ...current, timers: nextTimers, activeTimerId: targetId };
    });
    setCookTimerJustStarted(true);
  }

  function deleteTimer(id: string) {
    setCookSession((current) => {
      if (!current) return current;
      const next = removeCookTimer(current.timers, current.activeTimerId, id);
      return {
        ...current,
        timers: next.timers,
        activeTimerId: next.activeTimerId,
      };
    });
  }

  function setCookAssistantMessages(messages: RecipeCookAssistantMessage[]) {
    setCookSession((current) => {
      if (!current) return current;
      return { ...current, aiAssistantMessages: messages.slice(-40) };
    });
  }

  function selectTimer(id: string) {
    updateCookSession({ activeTimerId: id });
  }

  function toggleTimerById(id: string) {
    setCookSession((current) => {
      if (!current) return current;
      const nextTimers = current.timers.map((t) => {
        if (t.id !== id) return t;
        if (t.running) {
          const advanced = advanceCookTimers([t]).timers[0] ?? t;
          return { ...advanced, running: false, lastTickedAt: null };
        }
        return { ...t, running: true, lastTickedAt: Date.now() };
      });
      return { ...current, timers: nextTimers };
    });
  }

  function transitionToStep(current: RecipeCookSessionState | RecipeCookSessionRuntime, nextStepIndex: number) {
    return transitionCookTimerForStep({
      timers: current.timers,
      activeTimerId: current.activeTimerId,
      currentStepIndex: current.currentStepIndex,
      nextStepIndex,
      nextStep: cookSteps[nextStepIndex],
      newTimerId: `timer-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`,
    });
  }

  function jumpToCookStep(index: number) {
    const nextStepIndex = clampStepIndex(index, Math.max(cookSteps.length, 1));
    setCookSession((current) => {
      if (!current) return current;
      const { timers: nextTimers, activeTimerId: nextActiveId } = transitionToStep(current, nextStepIndex);
      return {
        ...current,
        currentStepIndex: nextStepIndex,
        timers: nextTimers,
        activeTimerId: nextActiveId,
      };
    });
  }

  function clearScopedSessionIfMatches() {
    const scope = args.sessionScope;
    const expectedDescriptor = descriptorAtSessionStartRef.current;
    const expectedSessionKey = sessionKeyAtStartRef.current;
    if (scope && expectedDescriptor && expectedSessionKey) {
      compareAndClearCookSession({
        scope,
        expectedDescriptor,
        expectedSessionKey,
      });
    }
  }

  function resetActiveCookSession() {
    if (!activeCookCard) return;
    const planItemId = cookSession?.planItemId ?? null;
    const scope = args.sessionScope;
    if (scope) {
      clearScopedSessionIfMatches();
      const source = sourceRefFromPlanItemId(planItemId);
      const loaded = loadOrMigrateCookSession({
        scope,
        recipe: activeCookCard.recipe,
        foodId: args.foodId ?? '',
        source,
        planItemBaseUpdatedAt:
          cookSession && 'planItemBaseUpdatedAt' in cookSession
            ? (cookSession.planItemBaseUpdatedAt as string | null)
            : planItemBaseFromLaunch(args.launchContext, planItemId),
        ownershipVerified: false,
        launch: args.launchContext
          ? {
              date: args.launchContext.date,
              mealType: args.launchContext.mealType,
              servings: args.launchContext.servings,
            }
          : undefined,
      });
      // Force a brand-new session after explicit reset: abandon current then create defaults.
      const runtime = toRuntimeCookSession(loaded.session);
      // Replace completion ID and progress by building fresh if restored old data snuck in.
      if (loaded.restored) {
        compareAndClearCookSession({
          scope,
          expectedDescriptor: loaded.descriptor,
          expectedSessionKey: loaded.sessionKey,
        });
        const fresh = loadOrMigrateCookSession({
          scope,
          recipe: activeCookCard.recipe,
          foodId: args.foodId ?? '',
          source,
          planItemBaseUpdatedAt: planItemBaseFromLaunch(args.launchContext, planItemId),
          ownershipVerified: false,
          launch: args.launchContext
            ? {
                date: args.launchContext.date,
                mealType: args.launchContext.mealType,
                servings: args.launchContext.servings,
              }
            : undefined,
        });
        descriptorAtSessionStartRef.current = fresh.descriptor;
        sessionKeyAtStartRef.current = fresh.sessionKey;
        setCookSession(toRuntimeCookSession(fresh.session));
      } else {
        descriptorAtSessionStartRef.current = loaded.descriptor;
        sessionKeyAtStartRef.current = loaded.sessionKey;
        setCookSession(runtime);
      }
      setWasCookSessionRestored(false);
      setIsCookFinishOpen(false);
      setCookFinishStatusMessage(null);
      setCookCompletionResult(null);
      return;
    }

    const nextSession = buildDefaultCookSession(activeCookCard.recipe, planItemId);
    setCookSession(nextSession);
    setWasCookSessionRestored(false);
    setIsCookFinishOpen(false);
    setCookFinishStatusMessage(null);
    setCookCompletionResult(null);
    clearCookSession(activeCookCard.recipe.id, planItemId);
  }

  function exitCookMode(target: RecipeCookExitTarget = 'detail') {
    setIsCookFinishOpen(false);
    setCookSession((current) => {
      if (!current) return current;
      const nextTimers = current.timers.map((t) => {
        const advanced = advanceCookTimers([t]).timers[0] ?? t;
        return { ...advanced, running: false, lastTickedAt: null };
      });
      const nextSession = { ...current, timers: nextTimers };
      if (activeCookCard) {
        const scope = args.sessionScope;
        if (scope && 'completionRequestId' in nextSession) {
          const descriptor = saveCookSessionV3({
            scope,
            recipeId: activeCookCard.recipe.id,
            session: toPersistedCookSessionV3(nextSession as RecipeCookSessionRuntime),
          });
          if (descriptor) {
            descriptorAtSessionStartRef.current = descriptor;
            sessionKeyAtStartRef.current = buildCookSessionV3Key(
              scope,
              activeCookCard.recipe.id,
              sourceRefFromPlanItemId(nextSession.planItemId),
            );
          }
        } else {
          saveCookSession(activeCookCard.recipe.id, nextSession as RecipeCookSessionState);
        }
      }
      return nextSession;
    });
    setCookCard(null);
    if (target === 'source' && cookReturnTarget) {
      args.setView('library');
      args.onCookReturnToSource?.(cookReturnTarget);
      setCookReturnTarget(null);
      return;
    }
    setCookReturnTarget(null);
    args.setView(target === 'source' ? 'library' : target);
  }

  function toggleCookIngredient(itemId: string) {
    setCookSession((current) => {
      if (!current) return current;
      const checked = new Set(current.checkedIngredientIds);
      if (checked.has(itemId)) {
        checked.delete(itemId);
      } else {
        checked.add(itemId);
      }
      return { ...current, checkedIngredientIds: [...checked] };
    });
  }

  function completeCurrentCookStepAndContinue() {
    if (!currentCookStep || !cookSession) return;
    const isLastStep = cookSession.currentStepIndex >= cookSteps.length - 1;
    setCookSession((current) => {
      if (!current) return current;
      const completed = new Set(current.completedStepIds);
      completed.add(currentCookStep.id);
      const nextStepIndex = isLastStep ? current.currentStepIndex : clampStepIndex(current.currentStepIndex + 1, Math.max(cookSteps.length, 1));
      const nextTimerState = isLastStep
        ? { timers: current.timers, activeTimerId: current.activeTimerId }
        : transitionToStep(current, nextStepIndex);
      return {
        ...current,
        completedStepIds: [...completed],
        currentStepIndex: nextStepIndex,
        timers: nextTimerState.timers,
        activeTimerId: nextTimerState.activeTimerId,
      };
    });
    if (isLastStep) {
      // Freeze timers while the finish wizard is open so autosave does not keep advancing.
      setCookSession((current) => (current ? pauseAllCookTimers(current) : current));
      setIsCookFinishOpen(true);
    }
  }

  function moveCookStep(delta: number) {
    setCookSession((current) => {
      if (!current) return current;
      const nextStepIndex = clampStepIndex(current.currentStepIndex + delta, Math.max(cookSteps.length, 1));
      const { timers: nextTimers, activeTimerId: nextActiveId } = transitionToStep(current, nextStepIndex);
      return {
        ...current,
        currentStepIndex: nextStepIndex,
        timers: nextTimers,
        activeTimerId: nextActiveId,
      };
    });
  }

  async function submitCookRecipe(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!activeCookCard || !cookSession) return;
    setCookFinishStatusMessage(null);
    try {
      const completionRequestId = resolveCompletionRequestId(cookSession, activeCookCard.recipe.id);
      const planItemBaseUpdatedAt = resolvePlanItemBaseUpdatedAt(cookSession);
      const response = await args.cookRecipe(
        activeCookCard.recipe.id,
        buildCookPayload({
          servings: cookSession.servings,
          date: cookSession.date,
          mealType: cookSession.mealType,
          planItemId: cookSession.planItemId,
          resultNote: cookSession.resultNote,
          adjustments: cookSession.adjustments,
          rating: cookSession.rating,
          completionRequestId,
          planItemBaseUpdatedAt,
          allowPartialInventoryDeduction: true,
        })
      );

      const result = handleCookResult(response, {
        clear: () => {
          // Cache invalidation is scheduled by the cook mutation; clear only after both IDs are present.
          if (args.sessionScope) {
            clearScopedSessionIfMatches();
          } else {
            clearCookSession(activeCookCard.recipe.id, cookSession.planItemId);
          }
        },
      });

      if (result === 'incomplete') {
        setCookFinishStatusMessage('完成结果不完整，请重试');
        args.showRecipeNotice({
          tone: 'danger',
          title: '完成结果不完整',
          message: '完成结果不完整，请重试',
        });
        return;
      }

      // Lock before any post-success state updates so a racing timer tick cannot rewrite storage.
      completionLockedRef.current = true;
      setCookSession((current) => (current ? pauseAllCookTimers(current) : current));

      const message = getCookCompletionMessage(response, {
        recipeTitle: activeCookCard.recipe.title,
        date: cookSession.date,
        mealType: cookSession.mealType,
      });
      setCookFinishStatusMessage('烹饪完成');
      setCookCompletionResult({
        mealLogId: response.meal_log_id as string,
        cookLogId: response.cook_log_id as string,
        message,
        recipeTitle: activeCookCard.recipe.title,
      });
      args.setSelectedRecipeId(activeCookCard.recipe.id);
      args.showRecipeNotice({
        tone: 'success',
        title: '烹饪完成',
        message,
      });
    } catch (reason) {
      // Completion failure preserves session and descriptor for retry with the same completion_request_id.
      const message = resolveErrorMessage(reason, '完成烹饪失败');
      setCookFinishStatusMessage(message);
      args.showRecipeNotice({ tone: 'danger', title: '完成烹饪失败', message });
    }
  }

  function dismissCookCompletion(options?: { viewMeal?: boolean }) {
    const result = cookCompletionResult;
    // Belt-and-suspenders: clear any session that a racing write may have restored.
    if (result) {
      clearScopedSessionIfMatches();
      if (!args.sessionScope && activeCookCard) {
        clearCookSession(activeCookCard.recipe.id, cookSession?.planItemId ?? null);
      }
    }
    setCookCompletionResult(null);
    setCookFinishStatusMessage(null);
    setIsCookFinishOpen(false);
    if (result && options?.viewMeal) {
      args.onViewMealLog?.(result.mealLogId);
      closeCookDialog();
      return;
    }
    if (result) {
      args.onCookFinished?.();
    }
    closeCookDialog();
    args.setView('detail');
  }

  return {
    cookTimerMinuteWheelRef,
    cookTimerSecondWheelRef,
    activeCookCard,
    cookReturnTarget,
    cookPreview,
    cookPreviewError,
    isCookPreviewLoading,
    cookSession,
    setCookSession,
    wasCookSessionRestored,
    isCookFinishOpen,
    setIsCookFinishOpen,
    isCookTimerCustomOpen,
    setIsCookTimerCustomOpen,
    cookTimerPicker,
    setCookTimerPicker,
    cookTimerJustStarted,
    cookSteps,
    currentCookStep,
    currentStepSuggestedSeconds,
    cookTimerDisplaySeconds,
    cookTimerDurationSeconds,
    cookTimerProgress,
    cookProgressPercent,
    cookSubmitDisabled,
    cookFinishStatusMessage,
    cookCompletionResult,
    openCook,
    closeCookDialog,
    updateCookSession,
    selectCookTimerDuration,
    openCustomCookTimer,
    confirmCustomCookTimer,
    toggleCookTimer,
    resetCookTimer,
    addCookTimerSeconds,
    jumpToCookStep,
    resetActiveCookSession,
    exitCookMode,
    toggleCookIngredient,
    completeCurrentCookStepAndContinue,
    moveCookStep,
    submitCookRecipe,
    dismissCookCompletion,
    timers: cookSession?.timers ?? [],
    activeTimerId: cookSession?.activeTimerId ?? '',
    addTimer,
    startTimerById,
    pauseTimerById,
    resetTimerById,
    addTimerSecondsById,
    setTimerById,
    setCookAssistantMessages,
    deleteTimer,
    selectTimer,
    toggleTimerById,
    cookCollision,
    continueExistingCook,
    abandonAndStartNewCook,
    dismissCookCollision,
    clearScopedSessionIfMatches,
  };
}
