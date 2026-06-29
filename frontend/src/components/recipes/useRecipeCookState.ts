import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { CookRecipePreviewResponse, CookRecipeRequest, CookRecipeResponse } from '../../api/types';
import {
  buildCookPayload,
  buildDefaultCookSession,
  clampStepIndex,
  clearCookSession,
  getNextManualTimerName,
  getCookCompletionMessage,
  getStepSuggestedSeconds,
  loadCookSession,
  removeCookTimer,
  resolveErrorMessage,
  saveCookSession,
  transitionCookTimerForStep,
  type RecipeCookAssistantMessage,
  type RecipeCookSessionState,
  type RecipeNotice,
} from './RecipeWorkspaceModel';
import type { RecipeCardViewModel, RecipeWorkspaceView } from './workspaceModel';

export function useRecipeCookState(args: {
  cards: RecipeCardViewModel[];
  selectedCard: RecipeCardViewModel | null;
  view: RecipeWorkspaceView;
  setView: (view: RecipeWorkspaceView) => void;
  setSelectedRecipeId: (recipeId: string | null) => void;
  startRecipeId?: string | null;
  startFoodPlanItemId?: string | null;
  onStartRecipeHandled?: () => void;
  previewCookRecipe: (recipeId: string, payload: CookRecipeRequest) => Promise<CookRecipePreviewResponse>;
  cookRecipe: (recipeId: string, payload: CookRecipeRequest) => Promise<CookRecipeResponse>;
  isCookingRecipe?: boolean;
  showRecipeNotice: (notice: RecipeNotice) => void;
}) {
  const cookTimerMinuteWheelRef = useRef<HTMLDivElement | null>(null);
  const cookTimerSecondWheelRef = useRef<HTMLDivElement | null>(null);
  const previewCookRecipeRef = useRef(args.previewCookRecipe);
  const [cookCard, setCookCard] = useState<RecipeCardViewModel | null>(null);
  const [cookPreview, setCookPreview] = useState<CookRecipePreviewResponse | null>(null);
  const [cookPreviewError, setCookPreviewError] = useState<string | null>(null);
  const [isCookPreviewLoading, setIsCookPreviewLoading] = useState(false);
  const [cookSession, setCookSession] = useState<RecipeCookSessionState | null>(null);
  const [wasCookSessionRestored, setWasCookSessionRestored] = useState(false);
  const [isCookFinishOpen, setIsCookFinishOpen] = useState(false);
  const [isCookTimerCustomOpen, setIsCookTimerCustomOpen] = useState(false);
  const [cookTimerPicker, setCookTimerPicker] = useState({ minutes: 2, seconds: 0 });
  const [cookTimerJustStarted, setCookTimerJustStarted] = useState(false);

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
    const payload = buildCookPayload({
      servings: cookSession.servings,
      date: cookSession.date,
      mealType: cookSession.mealType,
      createMealLog: cookSession.createMealLog,
      planItemId: cookSession.planItemId,
      resultNote: '',
      adjustments: cookSession.adjustments,
      rating: '',
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
  }, [
    activeCookCard?.recipe.id,
    cookSession?.servings,
    cookSession?.date,
    cookSession?.mealType,
    cookSession?.createMealLog,
    cookSession?.planItemId,
    cookSession?.adjustments,
  ]);

  useEffect(() => {
    if (args.view !== 'cook' || !activeCookCard || !cookSession) return;
    saveCookSession(activeCookCard.recipe.id, cookSession);
  }, [args.view, activeCookCard, cookSession]);

  useEffect(() => {
    if (args.view !== 'cook' || !cookSession) return;
    const hasRunningTimer = cookSession.timers.some((t) => t.running);
    if (!hasRunningTimer) return;
    const timer = window.setInterval(() => {
      setCookSession((current) => {
        if (!current) return current;
        let newlyFinishedTimerId: string | null = null;
        const nextTimers = current.timers.map((t) => {
          if (!t.running) return t;
          const duration = t.durationSeconds;
          if (t.mode === 'countdown' && duration) {
            const nextSeconds = t.seconds + 1;
            if (nextSeconds >= duration) {
              newlyFinishedTimerId = t.id;
              return { ...t, running: false, seconds: duration };
            }
            return { ...t, seconds: nextSeconds };
          }
          return { ...t, seconds: t.seconds + 1 };
        });
        const activeTimerId = newlyFinishedTimerId ? newlyFinishedTimerId : current.activeTimerId;
        return { ...current, timers: nextTimers, activeTimerId };
      });
    }, 1000);
    return () => window.clearInterval(timer);
  }, [args.view, cookSession?.timers]);

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

  function openCook(card: RecipeCardViewModel, planItemId?: string) {
    const loaded = loadCookSession(card.recipe, planItemId ?? null);
    args.setSelectedRecipeId(card.recipe.id);
    setCookCard(card);
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

  useEffect(() => {
    if (!args.startRecipeId) return;
    const targetCard = args.cards.find((card) => card.recipe.id === args.startRecipeId);
    if (!targetCard) return;
    openCook(targetCard, args.startFoodPlanItemId ?? undefined);
    args.onStartRecipeHandled?.();
  }, [args.cards, args.startFoodPlanItemId, args.startRecipeId]);

  function closeCookDialog() {
    setCookCard(null);
    setCookSession(null);
    setWasCookSessionRestored(false);
    setIsCookFinishOpen(false);
    setCookPreview(null);
    setCookPreviewError(null);
  }

  function updateCookSession(patch: Partial<RecipeCookSessionState>) {
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
          return { ...t, running: false };
        } else {
          const duration = t.durationSeconds ?? (t.id === 'default-timer' ? currentStepSuggestedSeconds : null);
          return {
            ...t,
            mode: duration ? ('countdown' as const) : ('countup' as const),
            durationSeconds: duration,
            running: true,
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
      const nextTimers = current.timers.map((t) => (t.id === targetId ? { ...t, running: false } : t));
      return { ...current, timers: nextTimers, activeTimerId: targetId };
    });
  }

  function resetTimerById(id?: string) {
    setCookSession((current) => {
      if (!current) return current;
      const targetId = id && current.timers.some((timer) => timer.id === id) ? id : current.activeTimerId;
      const nextTimers = current.timers.map((t) => (t.id === targetId ? { ...t, seconds: 0, running: false } : t));
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
        return { ...t, running: !t.running };
      });
      return { ...current, timers: nextTimers };
    });
  }

  function transitionToStep(current: RecipeCookSessionState, nextStepIndex: number) {
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

  function resetActiveCookSession() {
    if (!activeCookCard) return;
    const nextSession = buildDefaultCookSession(activeCookCard.recipe, cookSession?.planItemId ?? null);
    setCookSession(nextSession);
    setWasCookSessionRestored(false);
    setIsCookFinishOpen(false);
    clearCookSession(activeCookCard.recipe.id, cookSession?.planItemId ?? null);
  }

  function exitCookMode(target: 'detail' | 'library' = 'detail') {
    setIsCookFinishOpen(false);
    setCookSession((current) => {
      if (!current) return current;
      const nextTimers = current.timers.map((t) => ({ ...t, running: false }));
      return { ...current, timers: nextTimers };
    });
    setCookCard(null);
    args.setView(target);
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
    try {
      const response = await args.cookRecipe(
        activeCookCard.recipe.id,
        buildCookPayload({
          servings: cookSession.servings,
          date: cookSession.date,
          mealType: cookSession.mealType,
          createMealLog: cookSession.createMealLog,
          planItemId: cookSession.planItemId,
          resultNote: cookSession.resultNote,
          adjustments: cookSession.adjustments,
          rating: cookSession.rating,
          allowPartialInventoryDeduction: true,
        })
      );
      clearCookSession(activeCookCard.recipe.id, cookSession.planItemId);
      args.setSelectedRecipeId(activeCookCard.recipe.id);
      closeCookDialog();
      args.setView('detail');
      args.showRecipeNotice({
        tone: 'success',
        title: '烹饪完成',
        message: getCookCompletionMessage(response, cookSession.createMealLog),
      });
    } catch (reason) {
      args.showRecipeNotice({ tone: 'danger', title: '开始做失败', message: resolveErrorMessage(reason, '开始做失败') });
    }
  }

  return {
    cookTimerMinuteWheelRef,
    cookTimerSecondWheelRef,
    activeCookCard,
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
  };
}
