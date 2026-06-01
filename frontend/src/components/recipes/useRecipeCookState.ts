import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { CookRecipePreviewResponse, CookRecipeRequest, CookRecipeResponse } from '../../api/types';
import {
  buildCookPayload,
  buildDefaultCookSession,
  clampStepIndex,
  clearCookSession,
  getStepSuggestedSeconds,
  loadCookSession,
  resolveErrorMessage,
  saveCookSession,
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
  const cookTimerDisplaySeconds =
    cookSession?.timerMode === 'countdown'
      ? Math.max((cookSession.timerDurationSeconds ?? currentStepSuggestedSeconds ?? 0) - cookSession.timerSeconds, 0)
      : cookSession?.timerSeconds ?? 0;
  const cookTimerDurationSeconds = cookSession?.timerDurationSeconds ?? currentStepSuggestedSeconds;
  const cookTimerProgress =
    cookSession?.timerMode === 'countdown' && cookTimerDurationSeconds
      ? Math.min(Math.max(cookSession.timerSeconds / cookTimerDurationSeconds, 0), 1)
      : 0;
  const cookProgressPercent = cookSteps.length > 0 ? Math.round((((cookSession?.currentStepIndex ?? 0) + 1) / cookSteps.length) * 100) : 0;
  const cookSubmitDisabled =
    args.isCookingRecipe || isCookPreviewLoading || Boolean(cookPreviewError) || Boolean(cookPreview?.shortages.length) || !cookPreview || !cookSession;

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
    if (args.view !== 'cook' || !cookSession?.timerRunning) return;
    const timer = window.setInterval(() => {
      setCookSession((current) => {
        if (!current) return current;
        const duration = current.timerDurationSeconds;
        if (current.timerMode === 'countdown' && duration && current.timerSeconds >= duration) {
          return { ...current, timerRunning: false, timerSeconds: duration };
        }
        return { ...current, timerSeconds: current.timerSeconds + 1 };
      });
    }, 1000);
    return () => window.clearInterval(timer);
  }, [args.view, cookSession?.timerRunning]);

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
    updateCookSession({
      timerMode: seconds ? 'countdown' : 'countup',
      timerDurationSeconds: seconds,
      timerSeconds: 0,
      timerRunning: false,
    });
  }

  function openCustomCookTimer() {
    const duration = cookSession?.timerDurationSeconds ?? currentStepSuggestedSeconds ?? 120;
    setCookTimerPicker({
      minutes: Math.min(Math.floor(duration / 60), 59),
      seconds: duration % 60,
    });
    setIsCookTimerCustomOpen((current) => !current);
  }

  function confirmCustomCookTimer() {
    const duration = cookTimerPicker.minutes * 60 + cookTimerPicker.seconds;
    if (duration <= 0) return;
    updateCookSession({
      timerMode: 'countdown',
      timerDurationSeconds: duration,
      timerSeconds: 0,
      timerRunning: true,
    });
    setIsCookTimerCustomOpen(false);
    setCookTimerJustStarted(true);
  }

  function startCookTimer() {
    const duration = cookSession?.timerDurationSeconds ?? currentStepSuggestedSeconds;
    updateCookSession({
      timerMode: duration ? 'countdown' : 'countup',
      timerDurationSeconds: duration,
      timerRunning: true,
    });
    setCookTimerJustStarted(true);
  }

  function toggleCookTimer() {
    if (cookSession?.timerRunning) {
      updateCookSession({ timerRunning: false });
    } else {
      startCookTimer();
    }
  }

  function resetCookTimer() {
    updateCookSession({
      timerSeconds: 0,
      timerRunning: false,
      timerMode: cookSession?.timerDurationSeconds ?? currentStepSuggestedSeconds ? 'countdown' : 'countup',
      timerDurationSeconds: cookSession?.timerDurationSeconds ?? currentStepSuggestedSeconds,
    });
  }

  function addCookTimerSeconds(seconds: number) {
    setCookSession((current) => {
      if (!current || current.timerMode !== 'countdown') return current;
      const duration = current.timerDurationSeconds ?? currentStepSuggestedSeconds ?? 0;
      return {
        ...current,
        timerDurationSeconds: Math.max(duration + seconds, seconds),
      };
    });
  }

  function jumpToCookStep(index: number) {
    const nextStepIndex = clampStepIndex(index, Math.max(cookSteps.length, 1));
    const nextSuggestedSeconds = getStepSuggestedSeconds(cookSteps[nextStepIndex]);
    updateCookSession({
      currentStepIndex: nextStepIndex,
      timerSeconds: 0,
      timerRunning: false,
      timerMode: nextSuggestedSeconds ? 'countdown' : 'countup',
      timerDurationSeconds: nextSuggestedSeconds,
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
    setCookSession((current) => (current ? { ...current, timerRunning: false } : current));
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
      const nextSuggestedSeconds = isLastStep ? current.timerDurationSeconds : getStepSuggestedSeconds(cookSteps[nextStepIndex]);
      return {
        ...current,
        completedStepIds: [...completed],
        currentStepIndex: nextStepIndex,
        timerSeconds: isLastStep ? current.timerSeconds : 0,
        timerRunning: isLastStep ? current.timerRunning : false,
        timerMode: nextSuggestedSeconds ? 'countdown' : 'countup',
        timerDurationSeconds: nextSuggestedSeconds,
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
      const nextSuggestedSeconds = getStepSuggestedSeconds(cookSteps[nextStepIndex]);
      return {
        ...current,
        currentStepIndex: nextStepIndex,
        timerSeconds: 0,
        timerRunning: false,
        timerMode: nextSuggestedSeconds ? 'countdown' : 'countup',
        timerDurationSeconds: nextSuggestedSeconds,
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
        })
      );
      if (response.shortages.length > 0) {
        args.showRecipeNotice({ tone: 'warning', title: '库存不足', message: response.shortages.map((item) => item.ingredient_name).join('、') });
        return;
      }
      clearCookSession(activeCookCard.recipe.id, cookSession.planItemId);
      args.setSelectedRecipeId(activeCookCard.recipe.id);
      closeCookDialog();
      args.setView('detail');
      args.showRecipeNotice({
        tone: 'success',
        title: '烹饪完成',
        message: cookSession.createMealLog ? '已扣减库存并生成餐食记录。' : '已扣减库存。',
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
  };
}
