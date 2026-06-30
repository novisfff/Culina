import { describe, expect, it, vi } from 'vitest';
import type { AiResultCard, Recipe } from '../../api/types';
import {
  buildCookingActionToolCardMessage,
  buildCookingAssistantRuntimeState,
  buildCookingAssistantSessionRevision,
  buildCookingAssistantSubject,
  executeCookingUiActions,
  parseCookingUiActionsCard,
} from './cookingAssistantModel';
import type { RecipeCookSessionState } from './RecipeWorkspaceModel';
import type { RecipeCardViewModel } from './workspaceModel';

const recipe: Recipe = {
  id: 'recipe-1',
  family_id: 'family-1',
  title: '番茄炒蛋',
  servings: 2,
  prep_minutes: 12,
  difficulty: 'easy',
  ingredient_items: [
    { id: 'ri-egg', ingredient_id: 'ingredient-egg', ingredient_name: '鸡蛋', quantity: 2, unit: '枚', note: '' },
    { id: 'ri-tomato', ingredient_id: 'ingredient-tomato', ingredient_name: '番茄', quantity: 1, unit: '个', note: '' },
  ],
  steps: [
    { id: 'step-1', title: '备菜', text: '切番茄，打鸡蛋。', summary: '处理食材', estimated_minutes: 2 },
    { id: 'step-2', title: '炒蛋', text: '蛋液下锅，刚凝固就盛出。', summary: '先炒鸡蛋', estimated_minutes: 3, tip: '别炒老' },
  ],
  tips: '',
  images: [],
  cook_logs: [],
  created_at: '2026-06-01T00:00:00Z',
  updated_at: '2026-06-01T00:00:00Z',
};

const cookSession: RecipeCookSessionState = {
  currentStepIndex: 1,
  checkedIngredientIds: ['ri-egg'],
  completedStepIds: ['step-1'],
  timers: [
    {
      id: 'timer-main',
      name: '炒蛋',
      seconds: 30,
      running: false,
      mode: 'countdown',
      durationSeconds: 180,
      source: 'step',
      stepId: 'step-2',
    },
  ],
  activeTimerId: 'timer-main',
  servings: '2',
  date: '2026-06-28',
  mealType: 'dinner',
  createMealLog: true,
  planItemId: null,
  adjustments: '',
  resultNote: '',
  rating: '',
  aiAssistantMessages: [
    { id: 'cook-user-previous', role: 'user', text: '我刚才已经切好番茄了' },
    { id: 'cook-assistant-previous', role: 'assistant', text: '好，下一步先把鸡蛋打散。' },
  ],
};

function cardViewModel(): RecipeCardViewModel {
  return {
    recipe,
    availability: 'ready',
    availabilityLabel: '可做',
    availabilityDetail: '',
    availabilityScore: 1,
    shortages: [],
    ingredientAvailability: recipe.ingredient_items.map((item) => ({
      item,
      ingredient: null,
      requiredQuantity: item.quantity,
      availableQuantity: item.quantity,
      missingQuantity: 0,
      unit: item.unit,
      ready: true,
    })),
    ingredientPreview: [],
    hiddenIngredientCount: 0,
    linkedFood: null,
    mealUsageCount: 0,
    lastUsedAt: null,
    searchText: '',
    updatedAt: recipe.updated_at,
  };
}

function subjectArgs() {
  return {
    activeCookCard: cardViewModel(),
    cookSession,
    cookSteps: recipe.steps,
    currentCookStep: recipe.steps[1],
    cookPreview: null,
    timers: cookSession.timers,
    activeTimerId: cookSession.activeTimerId,
    activeMobileTab: 'step' as const,
  };
}

describe('cookingAssistantModel', () => {
  it('builds compact cooking subject snapshots', () => {
    const subject = buildCookingAssistantSubject(subjectArgs());

    expect(subject.source).toBe('recipe_cook_page');
    expect(subject.recipe_id).toBe('recipe-1');
    expect(subject.extra.currentStep).toMatchObject({ id: 'step-2', title: '炒蛋' });
    expect(subject.extra.previousStep).toMatchObject({ id: 'step-1', title: '备菜' });
    expect(subject.extra.ingredients[0]).toMatchObject({ id: 'ri-egg', checked: true, ready: true });
    expect(subject.extra.timers[0]).toMatchObject({ id: 'timer-main', remainingSeconds: 150, display: '02:30' });
    expect(subject.extra.assistantConversation).toEqual([
      { role: 'user', text: '我刚才已经切好番茄了' },
      { role: 'assistant', text: '好，下一步先把鸡蛋打散。' },
    ]);
  });

  it('rejects stale ui action cards before executing callbacks', () => {
    const runtime = buildCookingAssistantRuntimeState(subjectArgs());
    const goNextStep = vi.fn();
    const result = executeCookingUiActions({
      surface: 'recipe_cook_page',
      recipeId: runtime.recipeId,
      cookSessionId: runtime.cookSessionId,
      sessionRevision: runtime.sessionRevision + 1,
      actions: [{ type: 'go_next_step' }],
      requiresConfirmation: false,
    }, runtime, {
      goNextStep,
      goPreviousStep: vi.fn(),
      jumpToStep: vi.fn(),
      switchTab: vi.fn(),
      startTimer: vi.fn(),
      pauseTimer: vi.fn(),
      resetTimer: vi.fn(),
      addTimerSeconds: vi.fn(),
      setTimer: vi.fn(),
      resetCookSession: vi.fn(),
      deleteTimer: vi.fn(),
      finishCooking: vi.fn(),
      openShoppingDialog: vi.fn(),
    });

    expect(result.status).toBe('rejected');
    expect(goNextStep).not.toHaveBeenCalled();
  });

  it('executes low risk timer actions after validation', () => {
    const runtime = buildCookingAssistantRuntimeState(subjectArgs());
    const setTimer = vi.fn();
    const result = executeCookingUiActions({
      surface: 'recipe_cook_page',
      recipeId: runtime.recipeId,
      cookSessionId: runtime.cookSessionId,
      sessionRevision: buildCookingAssistantSessionRevision(cookSession),
      actions: [{ type: 'set_timer', timerId: 'timer-main', seconds: 180, name: '炒蛋' }],
      requiresConfirmation: false,
    }, runtime, {
      goNextStep: vi.fn(),
      goPreviousStep: vi.fn(),
      jumpToStep: vi.fn(),
      switchTab: vi.fn(),
      startTimer: vi.fn(),
      pauseTimer: vi.fn(),
      resetTimer: vi.fn(),
      addTimerSeconds: vi.fn(),
      setTimer,
      resetCookSession: vi.fn(),
      deleteTimer: vi.fn(),
      finishCooking: vi.fn(),
      openShoppingDialog: vi.fn(),
    });

    expect(result.status).toBe('executed');
    expect(setTimer).toHaveBeenCalledWith('timer-main', 180, '炒蛋');
    expect(result.message).toBe('页面操作已执行。');
  });

  it('builds tool card status without chat bubble templates', () => {
    const runtime = buildCookingAssistantRuntimeState(subjectArgs());
    const data = {
      surface: 'recipe_cook_page' as const,
      recipeId: runtime.recipeId,
      cookSessionId: runtime.cookSessionId,
      sessionRevision: runtime.sessionRevision,
      actions: [{ type: 'set_timer' as const, timerId: 'timer-main', seconds: 300, name: '焖煮' }],
      requiresConfirmation: false,
    };

    expect(buildCookingActionToolCardMessage(data, 'executed')).toBe('页面操作\n设置 05:00 倒计时\n已执行');
  });

  it('rejects next step actions when already on the final step', () => {
    const runtime = buildCookingAssistantRuntimeState(subjectArgs());
    const goNextStep = vi.fn();
    const result = executeCookingUiActions({
      surface: 'recipe_cook_page',
      recipeId: runtime.recipeId,
      cookSessionId: runtime.cookSessionId,
      sessionRevision: runtime.sessionRevision,
      actions: [{ type: 'go_next_step' }],
      requiresConfirmation: false,
    }, runtime, {
      goNextStep,
      goPreviousStep: vi.fn(),
      jumpToStep: vi.fn(),
      switchTab: vi.fn(),
      startTimer: vi.fn(),
      pauseTimer: vi.fn(),
      resetTimer: vi.fn(),
      addTimerSeconds: vi.fn(),
      setTimer: vi.fn(),
      resetCookSession: vi.fn(),
      deleteTimer: vi.fn(),
      finishCooking: vi.fn(),
      openShoppingDialog: vi.fn(),
    });

    expect(result.status).toBe('rejected');
    expect(result.message).toBe('已经是最后一步了。');
    expect(goNextStep).not.toHaveBeenCalled();
  });

  it('keeps running timer ticks from invalidating action cards while tracking state changes', () => {
    const runningSession: RecipeCookSessionState = {
      ...cookSession,
      timers: [{ ...cookSession.timers[0], running: true, seconds: 30 }],
    };
    const advancedRunningSession: RecipeCookSessionState = {
      ...cookSession,
      timers: [{ ...cookSession.timers[0], running: true, seconds: 90 }],
    };
    const pausedSession: RecipeCookSessionState = {
      ...cookSession,
      timers: [{ ...cookSession.timers[0], running: false, seconds: 90 }],
    };

    expect(buildCookingAssistantSessionRevision(runningSession)).toBe(buildCookingAssistantSessionRevision(advancedRunningSession));
    expect(buildCookingAssistantSessionRevision(runningSession)).not.toBe(buildCookingAssistantSessionRevision(pausedSession));
  });

  it('requires confirmation for high risk actions', () => {
    const runtime = buildCookingAssistantRuntimeState(subjectArgs());
    const resetCookSession = vi.fn();
    const data = {
      surface: 'recipe_cook_page' as const,
      recipeId: runtime.recipeId,
      cookSessionId: runtime.cookSessionId,
      sessionRevision: runtime.sessionRevision,
      actions: [{ type: 'reset_cook_session' as const }],
      requiresConfirmation: false,
    };
    const handlers = {
      goNextStep: vi.fn(),
      goPreviousStep: vi.fn(),
      jumpToStep: vi.fn(),
      switchTab: vi.fn(),
      startTimer: vi.fn(),
      pauseTimer: vi.fn(),
      resetTimer: vi.fn(),
      addTimerSeconds: vi.fn(),
      setTimer: vi.fn(),
      resetCookSession,
      deleteTimer: vi.fn(),
      finishCooking: vi.fn(),
      openShoppingDialog: vi.fn(),
    };

    expect(executeCookingUiActions(data, runtime, handlers).status).toBe('needs_confirmation');
    expect(resetCookSession).not.toHaveBeenCalled();
    expect(executeCookingUiActions(data, runtime, handlers, { confirmed: true }).status).toBe('executed');
    expect(resetCookSession).toHaveBeenCalledTimes(1);
  });

  it('requires confirmation before opening shopping flow', () => {
    const runtime = buildCookingAssistantRuntimeState(subjectArgs());
    const openShoppingDialog = vi.fn();
    const result = executeCookingUiActions({
      surface: 'recipe_cook_page',
      recipeId: runtime.recipeId,
      cookSessionId: runtime.cookSessionId,
      sessionRevision: runtime.sessionRevision,
      actions: [{ type: 'open_shopping_dialog' }],
      requiresConfirmation: false,
    }, runtime, {
      goNextStep: vi.fn(),
      goPreviousStep: vi.fn(),
      jumpToStep: vi.fn(),
      switchTab: vi.fn(),
      startTimer: vi.fn(),
      pauseTimer: vi.fn(),
      resetTimer: vi.fn(),
      addTimerSeconds: vi.fn(),
      setTimer: vi.fn(),
      resetCookSession: vi.fn(),
      deleteTimer: vi.fn(),
      finishCooking: vi.fn(),
      openShoppingDialog,
    });

    expect(result.status).toBe('needs_confirmation');
    expect(openShoppingDialog).not.toHaveBeenCalled();
  });

  it('parses ui action result cards', () => {
    const runtime = buildCookingAssistantRuntimeState(subjectArgs());
    const card: AiResultCard = {
      id: 'card-1',
      type: 'ui_actions',
      title: '页面操作建议',
      data: {
        surface: 'recipe_cook_page',
        recipeId: runtime.recipeId,
        cookSessionId: runtime.cookSessionId,
        sessionRevision: runtime.sessionRevision,
        actions: [{ type: 'switch_tab', tab: 'ingredients' }],
        requiresConfirmation: false,
      },
    };

    expect(parseCookingUiActionsCard(card)?.actions[0]).toEqual({ type: 'switch_tab', tab: 'ingredients' });
  });
});
