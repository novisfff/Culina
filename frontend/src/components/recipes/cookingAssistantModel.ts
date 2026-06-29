import type {
  AiCookPageAction,
  AiResultCard,
  AiUiActionsCardData,
  CookRecipePreviewResponse,
  RecipeStep,
} from '../../api/types';
import { formatCookShortageSummary, formatCookTimer, getRecipeStepSummary, getRecipeStepTitle, recipeCookSessionKey, type CookTimerState, type RecipeCookSessionState } from './RecipeWorkspaceModel';
import type { RecipeCardViewModel } from './workspaceModel';

export type CookingAssistantMobileTab = 'step' | 'ingredients';

export const COOKING_ASSISTANT_QUICK_PROMPTS = [
  '这一步做到什么程度？',
  '下一步要先准备什么？',
  '帮我开始计时',
  '下一步',
];

export type CookingAssistantSubjectArgs = {
  activeCookCard: RecipeCardViewModel;
  cookSession: RecipeCookSessionState;
  cookSteps: RecipeStep[];
  currentCookStep: RecipeStep | null;
  cookPreview: CookRecipePreviewResponse | null;
  timers: CookTimerState[];
  activeTimerId: string;
  activeMobileTab: CookingAssistantMobileTab;
};

export type CookingAssistantRuntimeState = {
  recipeId: string;
  cookSessionId: string;
  sessionRevision: number;
  currentStepIndex: number;
  stepCount: number;
  timers: CookTimerState[];
  activeTimerId: string;
  shortageCount: number;
};

export type CookingAssistantActionHandlers = {
  goNextStep: () => void;
  goPreviousStep: () => void;
  jumpToStep: (index: number) => void;
  switchTab: (tab: CookingAssistantMobileTab) => void;
  startTimer: (timerId?: string) => void;
  pauseTimer: (timerId?: string) => void;
  resetTimer: (timerId?: string) => void;
  addTimerSeconds: (timerId: string | undefined, seconds: number) => void;
  setTimer: (timerId: string | undefined, seconds: number, name?: string) => void;
  resetCookSession: () => void;
  deleteTimer: (timerId: string) => void;
  finishCooking: () => void;
  openShoppingDialog: () => void;
};

export type CookingAssistantActionResult = {
  status: 'executed' | 'needs_confirmation' | 'rejected';
  message: string;
  data?: AiUiActionsCardData;
};

const HIGH_RISK_ACTIONS = new Set<AiCookPageAction['type']>([
  'reset_cook_session',
  'delete_timer',
  'finish_cooking',
  'open_shopping_dialog',
]);

function stableHash(value: string) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export function buildCookingAssistantSessionRevision(cookSession: RecipeCookSessionState) {
  return stableHash(JSON.stringify({
    currentStepIndex: cookSession.currentStepIndex,
    checkedIngredientIds: [...cookSession.checkedIngredientIds].sort(),
    completedStepIds: [...cookSession.completedStepIds].sort(),
    timers: cookSession.timers.map((timer) => ({
      id: timer.id,
      name: timer.name,
      mode: timer.mode,
      durationSeconds: timer.durationSeconds,
      seconds: timer.running ? null : timer.seconds,
      running: timer.running,
      source: timer.source,
      stepId: timer.stepId,
    })),
    activeTimerId: cookSession.activeTimerId,
    servings: cookSession.servings,
    planItemId: cookSession.planItemId,
  }));
}

export function getCookingAssistantSessionId(recipeId: string, cookSession: RecipeCookSessionState) {
  return recipeCookSessionKey(recipeId, cookSession.planItemId);
}

function stepSnapshot(step: RecipeStep | null | undefined, index: number) {
  if (!step) return null;
  return {
    id: step.id,
    index,
    title: getRecipeStepTitle(step, index),
    text: step.text,
    summary: getRecipeStepSummary(step),
    estimatedMinutes: step.estimated_minutes ?? null,
    tip: step.tip || '',
    keyPoints: step.key_points ?? [],
  };
}

export function buildCookingAssistantRuntimeState(args: CookingAssistantSubjectArgs): CookingAssistantRuntimeState {
  return {
    recipeId: args.activeCookCard.recipe.id,
    cookSessionId: getCookingAssistantSessionId(args.activeCookCard.recipe.id, args.cookSession),
    sessionRevision: buildCookingAssistantSessionRevision(args.cookSession),
    currentStepIndex: args.cookSession.currentStepIndex,
    stepCount: args.cookSteps.length,
    timers: args.timers,
    activeTimerId: args.activeTimerId,
    shortageCount: args.cookPreview?.shortages.length ?? args.activeCookCard.shortages.length,
  };
}

export function buildCookingAssistantSubject(args: CookingAssistantSubjectArgs) {
  const runtime = buildCookingAssistantRuntimeState(args);
  const recipe = args.activeCookCard.recipe;
  const previousStep = args.cookSteps[args.cookSession.currentStepIndex - 1] ?? null;
  const nextStep = args.cookSteps[args.cookSession.currentStepIndex + 1] ?? null;
  return {
    source: 'recipe_cook_page',
    recipe_id: recipe.id,
    extra: {
      surface: 'recipe_cook_page',
      cookSessionId: runtime.cookSessionId,
      sessionRevision: runtime.sessionRevision,
      recipeTitle: recipe.title,
      servings: Number(args.cookSession.servings) || recipe.servings,
      currentStepIndex: args.cookSession.currentStepIndex,
      currentStep: stepSnapshot(args.currentCookStep, args.cookSession.currentStepIndex),
      previousStep: stepSnapshot(previousStep, args.cookSession.currentStepIndex - 1),
      nextStep: stepSnapshot(nextStep, args.cookSession.currentStepIndex + 1),
      totalSteps: args.cookSteps.length,
      checkedIngredientIds: args.cookSession.checkedIngredientIds,
      ingredients: recipe.ingredient_items.map((item) => {
        const availability = args.activeCookCard.ingredientAvailability.find((entry) => entry.item.id === item.id);
        const checked = args.cookSession.checkedIngredientIds.includes(item.id);
        return {
          id: item.id,
          ingredientId: item.ingredient_id ?? null,
          name: item.ingredient_name,
          quantity: item.quantity,
          unit: item.unit,
          note: item.note,
          checked,
          ready: availability?.ready ?? null,
          missingQuantity: availability?.missingQuantity ?? null,
          availabilityText: availability
            ? availability.ready
              ? '已备齐'
              : `缺 ${availability.missingQuantity}${availability.unit}`
            : '',
        };
      }),
      shortages: (args.cookPreview?.shortages ?? args.activeCookCard.shortages).map((item) => {
        if ('ingredient_name' in item) {
          return {
            ingredientId: item.ingredient_id ?? null,
            ingredientName: item.ingredient_name,
            requiredQuantity: item.required_quantity,
            availableQuantity: item.available_quantity,
            missingQuantity: item.missing_quantity,
            unit: item.unit,
            summary: formatCookShortageSummary(item),
          };
        }
        return {
          ingredientId: item.ingredientId ?? null,
          ingredientName: item.ingredientName,
          requiredQuantity: item.requiredQuantity,
          availableQuantity: item.availableQuantity,
          missingQuantity: item.missingQuantity,
          unit: item.unit,
          summary: `${item.ingredientName}缺 ${item.missingQuantity}${item.unit}`,
        };
      }),
      timers: args.timers.map((timer) => ({
        id: timer.id,
        name: timer.name,
        mode: timer.mode,
        durationSeconds: timer.durationSeconds,
        seconds: timer.seconds,
        remainingSeconds: timer.mode === 'countdown' ? Math.max((timer.durationSeconds ?? 0) - timer.seconds, 0) : null,
        display: formatCookTimer(timer.mode === 'countdown' ? Math.max((timer.durationSeconds ?? 0) - timer.seconds, 0) : timer.seconds),
        running: timer.running,
        active: timer.id === args.activeTimerId,
      })),
      activeTimerId: args.activeTimerId || null,
      activeMobileTab: args.activeMobileTab,
      assistantConversation: args.cookSession.aiAssistantMessages.slice(-12).map((message) => ({
        role: message.role,
        text: message.text,
      })),
    },
  };
}

export function parseCookingUiActionsCard(card: AiResultCard): AiUiActionsCardData | null {
  if (card.type !== 'ui_actions') return null;
  const data = card.data as Partial<AiUiActionsCardData>;
  if (data.surface !== 'recipe_cook_page' || !Array.isArray(data.actions)) return null;
  if (typeof data.recipeId !== 'string' || typeof data.cookSessionId !== 'string') return null;
  if (typeof data.sessionRevision !== 'number') return null;
  return {
    surface: 'recipe_cook_page',
    recipeId: data.recipeId,
    cookSessionId: data.cookSessionId,
    sessionRevision: data.sessionRevision,
    actions: data.actions,
    requiresConfirmation: Boolean(data.requiresConfirmation),
  };
}

function timerExists(state: CookingAssistantRuntimeState, timerId: string | undefined) {
  if (!timerId) return Boolean(state.activeTimerId && state.timers.some((timer) => timer.id === state.activeTimerId));
  return state.timers.some((timer) => timer.id === timerId);
}

function validateAction(action: AiCookPageAction, state: CookingAssistantRuntimeState): string | null {
  switch (action.type) {
    case 'go_next_step':
      return state.currentStepIndex < state.stepCount - 1 ? null : '已经是最后一步了。';
    case 'go_previous_step':
      return state.currentStepIndex > 0 ? null : '已经是第一步了。';
    case 'jump_to_step':
      return Number.isInteger(action.stepIndex) && action.stepIndex >= 0 && action.stepIndex < state.stepCount ? null : '这个步骤不存在。';
    case 'switch_tab':
      return action.tab === 'step' || action.tab === 'ingredients' ? null : '这个页面区域不能切换。';
    case 'start_timer':
    case 'pause_timer':
    case 'reset_timer':
      return timerExists(state, action.timerId) ? null : '没有找到这个计时器。';
    case 'add_timer_seconds': {
      if (!timerExists(state, action.timerId)) return '没有找到这个计时器。';
      const target = state.timers.find((timer) => timer.id === (action.timerId ?? state.activeTimerId));
      if (target?.mode !== 'countdown') return '只有倒计时可以加时。';
      return action.seconds > 0 && action.seconds <= 21600 ? null : '加时时长不合适。';
    }
    case 'set_timer':
      return action.seconds > 0 && action.seconds <= 21600 ? null : '计时时长不合适。';
    case 'delete_timer':
      if (!timerExists(state, action.timerId)) return '没有找到这个计时器。';
      return state.timers.length > 1 ? null : '至少要保留一个计时器。';
    case 'reset_cook_session':
    case 'finish_cooking':
    case 'open_shopping_dialog':
      return null;
    default:
      return '暂不支持这个页面操作。';
  }
}

export function validateCookingUiActions(data: AiUiActionsCardData, state: CookingAssistantRuntimeState): string | null {
  if (data.surface !== 'recipe_cook_page') return '这个操作不属于当前页面。';
  if (data.recipeId !== state.recipeId) return '这个操作不属于当前菜谱。';
  if (data.cookSessionId !== state.cookSessionId) return '这个操作不属于当前烹饪会话。';
  if (data.sessionRevision !== state.sessionRevision) return '页面状态刚更新了一下，请再说一遍。';
  if (!data.actions.length || data.actions.length > 4) return '页面操作数量不合适。';
  for (const action of data.actions) {
    const error = validateAction(action, state);
    if (error) return error;
  }
  return null;
}

export function cookingUiActionsNeedConfirmation(data: AiUiActionsCardData) {
  return data.requiresConfirmation || data.actions.some((action) => HIGH_RISK_ACTIONS.has(action.type));
}

export function describeCookingAction(action: AiCookPageAction) {
  switch (action.type) {
    case 'go_next_step':
      return '进入下一步';
    case 'go_previous_step':
      return '回到上一步';
    case 'jump_to_step':
      return `跳到第 ${action.stepIndex + 1} 步`;
    case 'switch_tab':
      return action.tab === 'ingredients' ? '打开食材清单' : '打开步骤详情';
    case 'start_timer':
      return '开始计时';
    case 'pause_timer':
      return '暂停计时';
    case 'reset_timer':
      return '重置计时器';
    case 'add_timer_seconds':
      return `加 ${action.seconds} 秒`;
    case 'set_timer':
      return `设置 ${formatCookTimer(action.seconds)} 倒计时`;
    case 'reset_cook_session':
      return '重新开始烹饪';
    case 'delete_timer':
      return '删除计时器';
    case 'finish_cooking':
      return '打开完成烹饪确认';
    case 'open_shopping_dialog':
      return '打开采购清单';
    default:
      return '页面操作';
  }
}

export function buildCookingActionTaskText(data: AiUiActionsCardData) {
  const actionText = data.actions.map(describeCookingAction).join('、');
  return actionText || '页面操作';
}

export function buildCookingActionToolCardMessage(data: AiUiActionsCardData, status: CookingAssistantActionResult['status'], message?: string) {
  const statusText = status === 'executed' ? '已执行' : status === 'needs_confirmation' ? '等待确认' : '未执行';
  return ['页面操作', status === 'rejected' && message ? message : buildCookingActionTaskText(data), statusText].join('\n');
}

function executeAction(action: AiCookPageAction, handlers: CookingAssistantActionHandlers) {
  switch (action.type) {
    case 'go_next_step':
      handlers.goNextStep();
      break;
    case 'go_previous_step':
      handlers.goPreviousStep();
      break;
    case 'jump_to_step':
      handlers.jumpToStep(action.stepIndex);
      break;
    case 'switch_tab':
      handlers.switchTab(action.tab);
      break;
    case 'start_timer':
      handlers.startTimer(action.timerId);
      break;
    case 'pause_timer':
      handlers.pauseTimer(action.timerId);
      break;
    case 'reset_timer':
      handlers.resetTimer(action.timerId);
      break;
    case 'add_timer_seconds':
      handlers.addTimerSeconds(action.timerId, action.seconds);
      break;
    case 'set_timer':
      handlers.setTimer(action.timerId, action.seconds, action.name);
      break;
    case 'reset_cook_session':
      handlers.resetCookSession();
      break;
    case 'delete_timer':
      handlers.deleteTimer(action.timerId);
      break;
    case 'finish_cooking':
      handlers.finishCooking();
      break;
    case 'open_shopping_dialog':
      handlers.openShoppingDialog();
      break;
  }
}

export function executeCookingUiActions(
  data: AiUiActionsCardData,
  state: CookingAssistantRuntimeState,
  handlers: CookingAssistantActionHandlers,
  options: { confirmed?: boolean } = {},
): CookingAssistantActionResult {
  const error = validateCookingUiActions(data, state);
  if (error) {
    return { status: 'rejected', message: error, data };
  }
  if (cookingUiActionsNeedConfirmation(data) && !options.confirmed) {
    return { status: 'needs_confirmation', message: '需要确认后再执行。', data };
  }
  data.actions.forEach((action) => executeAction(action, handlers));
  return { status: 'executed', message: '页面操作已执行。', data };
}
