import { useEffect, useMemo, useState } from 'react';
import type { Food, FoodPlanItem, Recipe } from '../../api/types';
import type { CookLaunchContext } from '../../app/appNavigationModel';
import { ActionButton } from '../../components/ui-kit';
import {
  buildCookSessionV3Key,
  compareAndClearCookSession,
  isCookSessionExpired,
  readActiveCook,
  readCookSessionV3,
  type ActiveCookDescriptor,
  type RecipeCookSessionScope,
} from '../../components/recipes/recipeCookSessionStorage';

export type ActiveCookResumeCardProps = {
  scope: RecipeCookSessionScope | null | undefined;
  recipes: Recipe[];
  foods: Food[];
  foodPlanItems?: FoodPlanItem[];
  onResume: (args: {
    food: Food;
    recipe: Recipe;
    launchContext: CookLaunchContext;
  }) => void;
  onNotice?: (notice: { tone: 'warning' | 'danger' | 'success'; title: string; message: string }) => void;
  /** Optional storage for tests. Defaults to localStorage. */
  storage?: Storage;
  now?: number;
};

function uniqueFoodForRecipe(foods: Food[], recipeId: string): Food | null {
  const matches = foods.filter((food) => food.recipe_id === recipeId);
  if (matches.length !== 1) return null;
  return matches[0];
}

function buildLaunchFromDescriptor(
  descriptor: ActiveCookDescriptor,
  recipe: Recipe,
  session: {
    date: string;
    mealType: CookLaunchContext['mealType'];
    servings: string;
    planItemBaseUpdatedAt: string | null;
  },
  planItem: FoodPlanItem | null,
): CookLaunchContext {
  const servings = Number(session.servings);
  const safeServings = Number.isFinite(servings) && servings > 0 ? servings : recipe.servings;
  if (descriptor.foodPlanItemId) {
    return {
      date: session.date,
      mealType: session.mealType,
      servings: safeServings,
      source: {
        kind: 'plan',
        foodPlanItemId: descriptor.foodPlanItemId,
        planItemBaseUpdatedAt:
          session.planItemBaseUpdatedAt || planItem?.updated_at || '',
      },
    };
  }
  return {
    date: session.date,
    mealType: session.mealType,
    servings: safeServings,
    source: { kind: 'direct' },
  };
}

/**
 * Compact Discover resume entry for the current authenticated cook namespace.
 * Does not auto-open a cook task; resolves entities before resume.
 */
export function ActiveCookResumeCard(props: ActiveCookResumeCardProps) {
  const storage = props.storage ?? localStorage;
  const now = props.now ?? Date.now();
  const [dismissed, setDismissed] = useState(false);
  const [revision, setRevision] = useState(0);

  const active = useMemo(() => {
    void revision;
    if (!props.scope || dismissed) return null;
    return readActiveCook(storage, props.scope);
    // revision forces re-read after cleanup
  }, [props.scope, storage, dismissed, revision]);

  const resolved = useMemo(() => {
    if (!props.scope || !active) return null;
    const source = active.foodPlanItemId
      ? ({ kind: 'plan' as const, foodPlanItemId: active.foodPlanItemId })
      : ({ kind: 'direct' as const });
    const sessionKey = buildCookSessionV3Key(props.scope, active.recipeId, source);
    const read = readCookSessionV3(storage, sessionKey, now);

    if (read.kind === 'missing' || read.kind === 'invalid' || read.kind === 'expired') {
      return { kind: 'stale' as const, descriptor: active, sessionKey };
    }
    if (read.kind === 'incompatible') {
      return { kind: 'incompatible' as const, descriptor: active, sessionKey };
    }

    const recipe = props.recipes.find((item) => item.id === active.recipeId) ?? null;
    if (!recipe) {
      return { kind: 'missing-recipe' as const, descriptor: active, sessionKey };
    }
    const food = uniqueFoodForRecipe(props.foods, recipe.id);
    if (!food) {
      return { kind: 'missing-food' as const, descriptor: active, sessionKey, recipe };
    }
    let planItem: FoodPlanItem | null = null;
    if (active.foodPlanItemId) {
      planItem = (props.foodPlanItems ?? []).find((item) => item.id === active.foodPlanItemId) ?? null;
      if (!planItem) {
        return { kind: 'missing-plan' as const, descriptor: active, sessionKey, recipe, food };
      }
    }

    // Guard against descriptor/session TTL drift.
    if (isCookSessionExpired(read.bundle.savedAt, read.bundle.source, now)) {
      return { kind: 'stale' as const, descriptor: active, sessionKey };
    }

    return {
      kind: 'ready' as const,
      descriptor: active,
      sessionKey,
      recipe,
      food,
      planItem,
      session: read.bundle.session,
    };
  }, [active, now, props.foodPlanItems, props.foods, props.recipes, props.scope, storage]);

  function clearCurrent(descriptor: ActiveCookDescriptor, sessionKey: string) {
    if (!props.scope) return;
    compareAndClearCookSession({
      storage,
      scope: props.scope,
      expectedDescriptor: descriptor,
      expectedSessionKey: sessionKey,
    });
    setDismissed(true);
    setRevision((value) => value + 1);
  }

  function notifyMissing(title: string, message: string) {
    props.onNotice?.({ tone: 'warning', title, message });
  }

  useEffect(() => {
    if (!resolved || resolved.kind === 'ready' || resolved.kind === 'incompatible') return;
    if (dismissed) return;
    clearCurrent(resolved.descriptor, resolved.sessionKey);
    if (resolved.kind === 'missing-recipe') {
      notifyMissing('上次做菜已失效', '对应菜谱已不存在，已清除本地进度。');
    } else if (resolved.kind === 'missing-food') {
      notifyMissing('上次做菜已失效', '做法与家常菜的关联需要修复，已清除本地进度。');
    } else if (resolved.kind === 'missing-plan') {
      notifyMissing('上次做菜已失效', '对应菜单项已不存在，已清除本地进度。');
    } else {
      notifyMissing('上次做菜已过期', '本地烹饪进度已过期并清除。');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resolved, dismissed]);

  if (!props.scope || !active || !resolved || resolved.kind !== 'ready') {
    return null;
  }

  const stepLabel = `第 ${resolved.session.currentStepIndex + 1} 步`;
  const sourceLabel = resolved.descriptor.foodPlanItemId ? '菜单继续' : '直接做菜';

  return (
    <section className="eat-active-cook-resume card" data-testid="active-cook-resume-card" aria-label="继续做菜">
      <div className="eat-active-cook-resume-copy">
        <strong className="eat-active-cook-resume-title">继续做菜</strong>
        <p className="eat-active-cook-resume-meta">
          {resolved.recipe.title}
          <span aria-hidden="true"> · </span>
          {stepLabel}
          <span aria-hidden="true"> · </span>
          {sourceLabel}
        </p>
      </div>
      <div className="eat-active-cook-resume-actions">
        <ActionButton
          type="button"
          tone="primary"
          size="compact"
          onClick={() => {
            props.onResume({
              food: resolved.food,
              recipe: resolved.recipe,
              launchContext: buildLaunchFromDescriptor(
                resolved.descriptor,
                resolved.recipe,
                {
                  date: resolved.session.date,
                  mealType: resolved.session.mealType,
                  servings: resolved.session.servings,
                  planItemBaseUpdatedAt: resolved.session.planItemBaseUpdatedAt,
                },
                resolved.planItem,
              ),
            });
          }}
        >
          继续做菜
        </ActionButton>
        <ActionButton
          type="button"
          tone="tertiary"
          size="compact"
          onClick={() => {
            clearCurrent(resolved.descriptor, resolved.sessionKey);
            props.onNotice?.({
              tone: 'success',
              title: '已放弃上次做菜',
              message: '本地进度已清除，可以重新开始。',
            });
          }}
        >
          放弃
        </ActionButton>
      </div>
    </section>
  );
}
