import type { MealType } from '../api/types';

export type PrimaryTabKey = 'home' | 'eat' | 'ingredients' | 'ai' | 'family';
export type EatBaseView = 'discover' | 'plan' | 'history';

export type CookLaunchContext = {
  date: string;
  mealType: MealType;
  servings: number;
  source:
    | { kind: 'direct' }
    | { kind: 'plan'; foodPlanItemId: string; planItemBaseUpdatedAt: string };
};

export type MealCreateSource =
  | { kind: 'direct' }
  | { kind: 'plan'; foodPlanItemId: string; planItemBaseUpdatedAt: string };

export type EatTask =
  | { kind: 'food-detail'; foodId: string; returnTo: EatBaseView }
  | { kind: 'recipe-target'; recipeId: string; mode: 'view' | 'edit'; returnTo: EatBaseView }
  | { kind: 'recipe'; foodId: string; recipeId: string; mode: 'view' | 'edit'; returnTo: EatBaseView }
  | { kind: 'plan-detail'; foodPlanItemId: string; returnTo: 'plan' }
  | { kind: 'cook'; foodId: string; recipeId: string; launchContext: CookLaunchContext; returnTo: EatBaseView }
  | {
      kind: 'meal-create';
      source: MealCreateSource;
      foodId?: string;
      date?: string;
      mealType?: MealType;
      returnTo: EatBaseView;
    }
  | { kind: 'meal-detail'; mealLogId: string; returnTo: EatBaseView };

export type AppNavigationState = {
  primaryTab: PrimaryTabKey;
  eat: { baseView: EatBaseView; task: EatTask | null; discoverSection: 'all' | 'selfMade' };
};

export type AppNavigationTarget =
  | { workspace: 'home' | 'ingredients' | 'ai' | 'family' }
  | { workspace: 'eat'; view: 'discover'; section?: 'all' | 'selfMade' }
  | { workspace: 'eat'; view: 'food'; foodId: string }
  | { workspace: 'eat'; view: 'recipe'; recipeId: string; mode?: 'view' | 'edit' }
  | { workspace: 'eat'; view: 'plan'; foodPlanItemId?: string }
  | { workspace: 'eat'; view: 'history'; mealLogId?: string }
  | { workspace: 'eat'; view: 'cook'; foodId: string; recipeId: string; launchContext: CookLaunchContext }
  | {
      workspace: 'eat';
      view: 'meal-create';
      source: MealCreateSource;
      foodId?: string;
      date?: string;
      mealType?: MealType;
    };

export type AppNavigationAction =
  | { type: 'navigate'; target: AppNavigationTarget }
  | { type: 'select-eat-view'; view: EatBaseView }
  | { type: 'close-task' };

export type PersistedNavigationV2 = {
  version: 2;
  primaryTab: PrimaryTabKey;
  eatBaseView: EatBaseView;
  discoverSection?: 'all' | 'selfMade';
};

export type AppQueryScope = {
  needsMembers: boolean;
  needsIngredients: boolean;
  needsInventory: boolean;
  needsShopping: boolean;
  needsRecipes: boolean;
  needsRecipeInsights: boolean;
  needsFoodPlan: boolean;
  needsFoodPlanDetail: boolean;
  needsFoodScenes: boolean;
  needsFoods: boolean;
  needsFoodRecommendations: boolean;
  needsMealLogs: boolean;
  needsActivityLogs: boolean;
  needsAiConversations: boolean;
};

export const initialNavigationState: AppNavigationState = {
  primaryTab: 'home',
  eat: { baseView: 'discover', task: null, discoverSection: 'all' },
};

const PRIMARY_TABS: ReadonlySet<PrimaryTabKey> = new Set(['home', 'eat', 'ingredients', 'ai', 'family']);
const EAT_BASE_VIEWS: ReadonlySet<EatBaseView> = new Set(['discover', 'plan', 'history']);
const DISCOVER_SECTIONS: ReadonlySet<'all' | 'selfMade'> = new Set(['all', 'selfMade']);

const EMPTY_QUERY_SCOPE: AppQueryScope = {
  needsMembers: false,
  needsIngredients: false,
  needsInventory: false,
  needsShopping: false,
  needsRecipes: false,
  needsRecipeInsights: false,
  needsFoodPlan: false,
  needsFoodPlanDetail: false,
  needsFoodScenes: false,
  needsFoods: false,
  needsFoodRecommendations: false,
  needsMealLogs: false,
  needsActivityLogs: false,
  needsAiConversations: false,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPrimaryTabKey(value: unknown): value is PrimaryTabKey {
  return typeof value === 'string' && PRIMARY_TABS.has(value as PrimaryTabKey);
}

function isEatBaseView(value: unknown): value is EatBaseView {
  return typeof value === 'string' && EAT_BASE_VIEWS.has(value as EatBaseView);
}

function isDiscoverSection(value: unknown): value is 'all' | 'selfMade' {
  return typeof value === 'string' && DISCOVER_SECTIONS.has(value as 'all' | 'selfMade');
}

function withEat(
  state: AppNavigationState,
  eat: Partial<AppNavigationState['eat']>,
  primaryTab: PrimaryTabKey = 'eat',
): AppNavigationState {
  return {
    primaryTab,
    eat: {
      ...state.eat,
      ...eat,
    },
  };
}

function closeTaskState(state: AppNavigationState): AppNavigationState {
  if (!state.eat.task) {
    return state;
  }
  return withEat(state, {
    baseView: state.eat.task.returnTo,
    task: null,
  });
}

function applyTarget(state: AppNavigationState, target: AppNavigationTarget): AppNavigationState {
  if (target.workspace !== 'eat') {
    return {
      primaryTab: target.workspace,
      eat: {
        ...state.eat,
        task: null,
      },
    };
  }

  switch (target.view) {
    case 'discover':
      return withEat(state, {
        baseView: 'discover',
        task: null,
        discoverSection: target.section ?? state.eat.discoverSection,
      });
    case 'plan':
      if (target.foodPlanItemId) {
        return withEat(state, {
          baseView: 'plan',
          task: {
            kind: 'plan-detail',
            foodPlanItemId: target.foodPlanItemId,
            returnTo: 'plan',
          },
        });
      }
      return withEat(state, { baseView: 'plan', task: null });
    case 'history':
      if (target.mealLogId) {
        return withEat(state, {
          baseView: 'history',
          task: {
            kind: 'meal-detail',
            mealLogId: target.mealLogId,
            returnTo: state.eat.baseView,
          },
        });
      }
      return withEat(state, { baseView: 'history', task: null });
    case 'food':
      return withEat(state, {
        task: {
          kind: 'food-detail',
          foodId: target.foodId,
          returnTo: state.eat.baseView,
        },
      });
    case 'recipe':
      return withEat(state, {
        task: {
          kind: 'recipe-target',
          recipeId: target.recipeId,
          mode: target.mode ?? 'view',
          returnTo: state.eat.baseView,
        },
      });
    case 'cook': {
      const returnTo =
        target.launchContext.source.kind === 'plan' ? 'plan' : state.eat.baseView;
      return withEat(state, {
        baseView: returnTo,
        task: {
          kind: 'cook',
          foodId: target.foodId,
          recipeId: target.recipeId,
          launchContext: target.launchContext,
          returnTo,
        },
      });
    }
    case 'meal-create': {
      const returnTo = target.source.kind === 'plan' ? 'plan' : state.eat.baseView;
      return withEat(state, {
        baseView: returnTo,
        task: {
          kind: 'meal-create',
          source: target.source,
          foodId: target.foodId,
          date: target.date,
          mealType: target.mealType,
          returnTo,
        },
      });
    }
    default: {
      const _exhaustive: never = target;
      return _exhaustive;
    }
  }
}

export function reduceNavigation(
  state: AppNavigationState,
  action: AppNavigationAction,
): AppNavigationState {
  switch (action.type) {
    case 'navigate':
      return applyTarget(state, action.target);
    case 'select-eat-view':
      return withEat(state, {
        baseView: action.view,
        task: null,
      });
    case 'close-task':
      return closeTaskState(state);
    default: {
      const _exhaustive: never = action;
      return _exhaustive;
    }
  }
}

export function migrateLegacyNavigation(legacyTab: string): AppNavigationState {
  switch (legacyTab) {
    case 'home':
      return { ...initialNavigationState, primaryTab: 'home' };
    case 'foods':
      return withEat(initialNavigationState, {
        baseView: 'discover',
        task: null,
        discoverSection: 'all',
      });
    case 'recipes':
      return withEat(initialNavigationState, {
        baseView: 'discover',
        task: null,
        discoverSection: 'selfMade',
      });
    case 'logs':
      return withEat(initialNavigationState, {
        baseView: 'history',
        task: null,
        discoverSection: 'all',
      });
    case 'ingredients':
      return { ...initialNavigationState, primaryTab: 'ingredients' };
    case 'ai':
      return { ...initialNavigationState, primaryTab: 'ai' };
    case 'family':
      return { ...initialNavigationState, primaryTab: 'family' };
    default:
      return initialNavigationState;
  }
}

export function parsePersistedNavigation(raw: string | null | undefined): AppNavigationState {
  if (!raw) {
    return initialNavigationState;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return initialNavigationState;
  }

  if (!isRecord(parsed) || parsed.version !== 2) {
    return initialNavigationState;
  }

  if (!isPrimaryTabKey(parsed.primaryTab) || !isEatBaseView(parsed.eatBaseView)) {
    return initialNavigationState;
  }

  const discoverSection = isDiscoverSection(parsed.discoverSection)
    ? parsed.discoverSection
    : 'all';

  return {
    primaryTab: parsed.primaryTab,
    eat: {
      baseView: parsed.eatBaseView,
      task: null,
      discoverSection,
    },
  };
}

export function persistedNavigationFromState(state: AppNavigationState): PersistedNavigationV2 {
  return {
    version: 2,
    primaryTab: state.primaryTab,
    eatBaseView: state.eat.baseView,
    discoverSection: state.eat.discoverSection,
  };
}

function enable(scope: AppQueryScope, keys: Array<keyof AppQueryScope>): AppQueryScope {
  const next = { ...scope };
  for (const key of keys) {
    next[key] = true;
  }
  return next;
}

function scopeForEatBaseView(baseView: EatBaseView): AppQueryScope {
  switch (baseView) {
    case 'discover':
      return enable(EMPTY_QUERY_SCOPE, [
        'needsIngredients',
        'needsInventory',
        'needsRecipes',
        'needsFoodScenes',
        'needsFoods',
        'needsFoodRecommendations',
        'needsMealLogs',
      ]);
    case 'plan':
      return enable(EMPTY_QUERY_SCOPE, [
        'needsRecipes',
        'needsFoodPlan',
        'needsFoods',
        'needsMealLogs',
      ]);
    case 'history':
      return enable(EMPTY_QUERY_SCOPE, [
        'needsMembers',
        'needsFoodPlan',
        'needsFoods',
        'needsMealLogs',
      ]);
    default: {
      const _exhaustive: never = baseView;
      return _exhaustive;
    }
  }
}

function scopeForEatTask(task: EatTask): AppQueryScope {
  switch (task.kind) {
    case 'food-detail':
      // selfMade may need ingredients/inventory; keep them enabled for the task shell.
      return enable(EMPTY_QUERY_SCOPE, [
        'needsIngredients',
        'needsInventory',
        'needsRecipes',
        'needsFoods',
        'needsMealLogs',
      ]);
    case 'recipe-target':
    case 'recipe':
      return enable(EMPTY_QUERY_SCOPE, [
        'needsIngredients',
        'needsInventory',
        'needsRecipes',
        'needsFoods',
        'needsMealLogs',
      ]);
    case 'plan-detail':
      return enable(EMPTY_QUERY_SCOPE, [
        'needsRecipes',
        'needsFoodPlan',
        'needsFoodPlanDetail',
        'needsFoods',
        'needsMealLogs',
      ]);
    case 'cook': {
      const keys: Array<keyof AppQueryScope> = [
        'needsIngredients',
        'needsInventory',
        'needsRecipes',
        'needsFoods',
      ];
      if (task.launchContext.source.kind === 'plan') {
        keys.push('needsFoodPlan');
      }
      return enable(EMPTY_QUERY_SCOPE, keys);
    }
    case 'meal-create': {
      const keys: Array<keyof AppQueryScope> = [
        'needsMembers',
        'needsFoodPlan',
        'needsFoods',
        'needsMealLogs',
      ];
      // Plan-origin meal-create reuses the ID detail query to attach the plan item.
      if (task.source.kind === 'plan') {
        keys.push('needsFoodPlanDetail');
      }
      return enable(EMPTY_QUERY_SCOPE, keys);
    }
    case 'meal-detail':
      return enable(EMPTY_QUERY_SCOPE, [
        'needsMembers',
        'needsFoodPlan',
        'needsFoods',
        'needsMealLogs',
      ]);
    default: {
      const _exhaustive: never = task;
      return _exhaustive;
    }
  }
}

export function deriveAppQueryScope(state: AppNavigationState): AppQueryScope {
  switch (state.primaryTab) {
    case 'home':
      return enable(EMPTY_QUERY_SCOPE, [
        'needsMembers',
        'needsIngredients',
        'needsInventory',
        'needsShopping',
        'needsRecipes',
        'needsFoodPlan',
        'needsFoods',
        'needsFoodRecommendations',
        'needsMealLogs',
      ]);
    case 'ingredients':
      return enable(EMPTY_QUERY_SCOPE, [
        'needsIngredients',
        'needsInventory',
        'needsShopping',
        'needsRecipes',
      ]);
    case 'ai':
      return enable(EMPTY_QUERY_SCOPE, ['needsAiConversations']);
    case 'family':
      return enable(EMPTY_QUERY_SCOPE, [
        'needsMembers',
        'needsRecipes',
        'needsFoods',
        'needsMealLogs',
        'needsActivityLogs',
      ]);
    case 'eat':
      if (state.eat.task) {
        return scopeForEatTask(state.eat.task);
      }
      return scopeForEatBaseView(state.eat.baseView);
    default: {
      const _exhaustive: never = state.primaryTab;
      return _exhaustive;
    }
  }
}
