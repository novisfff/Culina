// @vitest-environment jsdom

import { render, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ComponentProps } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { Recipe } from '../../api/types';
import { RecipeCookView } from './RecipeCookView';
import type { RecipeCookSessionState } from './RecipeWorkspaceModel';
import type { RecipeCardViewModel } from './workspaceModel';

vi.mock('./CookingAssistantPanel', () => ({
  CookingAssistantPanel: () => null,
}));

function makeRecipe(): Recipe {
  return {
    id: 'recipe-1',
    family_id: 'family-1',
    title: '番茄炒蛋',
    servings: 2,
    prep_minutes: 18,
    difficulty: 'easy',
    ingredient_items: [],
    steps: [{ id: 'step-1', title: '炒鸡蛋', text: '鸡蛋炒至七分熟。', key_points: [] }],
    tips: '',
    images: [],
    cook_logs: [],
    created_at: '2026-07-01T00:00:00.000Z',
    updated_at: '2026-07-01T00:00:00.000Z',
  };
}

function makeCard(recipe = makeRecipe()): RecipeCardViewModel {
  return {
    recipe,
    availability: 'partial',
    availabilityLabel: '缺少食材',
    availabilityDetail: '',
    availabilityScore: 0.5,
    shortages: [],
    ingredientAvailability: [],
    ingredientPreview: [],
    hiddenIngredientCount: 0,
    linkedFood: null,
    mealUsageCount: 0,
    lastUsedAt: null,
    searchText: recipe.title,
    updatedAt: recipe.updated_at,
  };
}

function makeSession(): RecipeCookSessionState {
  return {
    currentStepIndex: 0,
    checkedIngredientIds: [],
    completedStepIds: [],
    timers: [],
    activeTimerId: 'timer-1',
    servings: '2',
    date: '2026-07-14',
    mealType: 'dinner',
    planItemId: null,
    adjustments: '',
    resultNote: '',
    rating: '',
    aiAssistantMessages: [],
  };
}

function makeProps(overrides: Partial<ComponentProps<typeof RecipeCookView>> = {}): ComponentProps<typeof RecipeCookView> {
  const recipe = makeRecipe();
  const timer = {
    id: 'timer-1',
    name: '正计时',
    seconds: 0,
    running: false,
    lastTickedAt: null,
    mode: 'countup' as const,
    durationSeconds: null,
    source: 'manual' as const,
    stepId: null,
  };
  return {
    activeCookCard: makeCard(recipe),
    cookSession: makeSession(),
    cookSteps: recipe.steps,
    currentCookStep: recipe.steps[0]!,
    currentStepSuggestedSeconds: null,
    cookTimerDisplaySeconds: 0,
    cookTimerDurationSeconds: null,
    cookTimerProgress: 0,
    cookProgressPercent: 33,
    wasCookSessionRestored: false,
    cookPreview: null,
    isCreatingShopping: false,
    isCookTimerCustomOpen: false,
    cookTimerJustStarted: false,
    cookTimerPicker: { minutes: 0, seconds: 0 },
    cookTimerMinuteWheelRef: { current: null },
    cookTimerSecondWheelRef: { current: null },
    setCookTimerPicker: vi.fn(),
    setIsCookTimerCustomOpen: vi.fn(),
    exitCookMode: vi.fn(),
    jumpToCookStep: vi.fn(),
    moveCookStep: vi.fn(),
    completeCurrentCookStepAndContinue: vi.fn(),
    resetActiveCookSession: vi.fn(),
    openCookFinishDialog: vi.fn(),
    openShoppingDialog: vi.fn(),
    confirmCustomCookTimer: vi.fn(),
    openCustomCookTimer: vi.fn(),
    selectCookTimerDuration: vi.fn(),
    resetCookTimer: vi.fn(),
    toggleCookTimer: vi.fn(),
    addCookTimerSeconds: vi.fn(),
    toggleCookIngredient: vi.fn(),
    timers: [timer],
    activeTimerId: timer.id,
    addTimer: vi.fn(),
    deleteTimer: vi.fn(),
    selectTimer: vi.fn(),
    toggleTimerById: vi.fn(),
    startTimerById: vi.fn(),
    pauseTimerById: vi.fn(),
    resetTimerById: vi.fn(),
    addTimerSecondsById: vi.fn(),
    setTimerById: vi.fn(),
    setCookAssistantMessages: vi.fn(),
    ...overrides,
  };
}

describe('RecipeCookView desktop status placement', () => {
  it('moves shortage and restored actions into the header while keeping mobile status in the side panel', async () => {
    const resetActiveCookSession = vi.fn();
    const openShoppingDialog = vi.fn();
    const props = makeProps({
      wasCookSessionRestored: true,
      cookPreview: {
        recipe_id: 'recipe-1',
        preview_items: [],
        shortages: [{
          ingredient_id: 'ingredient-pepper',
          ingredient_name: '青椒',
          required_quantity: 1,
          available_quantity: 0,
          missing_quantity: 1,
          unit: '个',
        }],
      },
      resetActiveCookSession,
      openShoppingDialog,
    });
    const view = render(<RecipeCookView {...props} />);
    const header = view.container.querySelector<HTMLElement>('.recipe-cook-header');
    const sidePanel = view.container.querySelector<HTMLElement>('.recipe-cook-side-panel');

    expect(header).not.toBeNull();
    expect(sidePanel).not.toBeNull();
    expect(header?.querySelector('.recipe-cook-header-status')).not.toBeNull();
    expect(within(header!).getByText('缺 1 项食材')).toBeInTheDocument();
    expect(within(header!).getByText('已恢复进度')).toBeInTheDocument();
    expect(sidePanel?.querySelector('.recipe-cook-status-desktop')).toBeNull();
    expect(sidePanel?.querySelectorAll('.recipe-cook-status-mobile')).toHaveLength(2);

    await userEvent.click(within(header!).getByRole('button', { name: '采购' }));
    await userEvent.click(within(header!).getByRole('button', { name: '重来' }));
    expect(openShoppingDialog).toHaveBeenCalledWith(props.activeCookCard);
    expect(resetActiveCookSession).toHaveBeenCalledTimes(1);
  });
});
