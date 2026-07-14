// @vitest-environment jsdom

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { Food, Recipe } from '../../api/types';
import type { AppNavigationService } from '../../app/useAppNavigationState';
import type { AppNavigationState } from '../../app/appNavigationModel';
import { EatWorkspace, type EatWorkspaceProps } from './EatWorkspace';
import type { ResolvedEatTask } from './EatWorkspaceViewModel';

function makeRecipe(overrides: Partial<Recipe> = {}): Recipe {
  return {
    id: 'recipe-1',
    family_id: 'family-1',
    title: 'Tomato eggs',
    servings: 2,
    prep_minutes: 15,
    difficulty: 'easy',
    ingredient_items: [],
    steps: [],
    tips: '',
    images: [],
    cook_logs: [],
    created_at: '2026-07-01T00:00:00.000Z',
    updated_at: '2026-07-01T00:00:00.000Z',
    ...overrides,
  };
}

function makeFood(overrides: Partial<Food> = {}): Food {
  return {
    id: 'food-1',
    family_id: 'family-1',
    name: 'Tomato eggs',
    type: 'selfMade',
    category: 'home',
    flavor_tags: [],
    suitable_meal_types: ['dinner'],
    source_name: '',
    purchase_source: '',
    scene: '',
    images: [],
    notes: '',
    routine_note: '',
    stock_unit: '份',
    storage_location: '',
    favorite: false,
    recipe_id: 'recipe-1',
    row_version: 1,
    created_at: '2026-07-01T00:00:00.000Z',
    updated_at: '2026-07-01T00:00:00.000Z',
    ...overrides,
  };
}

function createNavigationService(
  stateOverrides: {
    primaryTab?: AppNavigationState['primaryTab'];
    eat?: Partial<AppNavigationState['eat']>;
  } = {},
): AppNavigationService {
  const state: AppNavigationState = {
    primaryTab: stateOverrides.primaryTab ?? 'eat',
    eat: {
      baseView: 'discover',
      task: null,
      discoverSection: 'all',
      ...stateOverrides.eat,
    },
  };

  return {
    state,
    navigate: vi.fn(),
    selectEatView: vi.fn(),
    closeTask: vi.fn(),
    registerTaskHeading: vi.fn(),
    registerBaseViewFocusTarget: vi.fn(),
  };
}

function createNavigationServiceWithFoodTask(): AppNavigationService {
  return createNavigationService({
    eat: {
      baseView: 'discover',
      discoverSection: 'all',
      task: { kind: 'food-detail', foodId: 'food-1', returnTo: 'discover' },
    },
  });
}

function makeEatProps(overrides: Partial<EatWorkspaceProps> = {}): EatWorkspaceProps {
  return {
    navigation: createNavigationService(),
    resolvedTask: { kind: 'none' },
    discoverContent: <div>发现内容</div>,
    historyContent: <div>吃过的内容</div>,
    ...overrides,
  };
}

describe('EatWorkspace', () => {
  it('renders cooking as the immersive workspace without the discovery surface', () => {
    const view = render(
      <EatWorkspace
        {...makeEatProps({
          resolvedTask: {
            kind: 'cook',
            food: makeFood(),
            recipe: makeRecipe(),
            launchContext: {
              date: '2026-07-14',
              mealType: 'dinner',
              servings: 2,
              source: { kind: 'direct' },
            },
          },
          cookTaskContent: <div>整屏做菜</div>,
        })}
      />,
    );

    expect(screen.getByText('整屏做菜')).toBeInTheDocument();
    expect(screen.queryByText('发现内容')).not.toBeInTheDocument();
    expect(view.container.querySelector('.recipe-workspace-cook-mode')).not.toBeNull();
  });

  it('keeps the food page behind the cook resume prompt', () => {
    const view = render(
      <EatWorkspace
        {...makeEatProps({
          resolvedTask: {
            kind: 'cook',
            food: makeFood(),
            recipe: makeRecipe(),
            launchContext: {
              date: '2026-07-14',
              mealType: 'dinner',
              servings: 2,
              source: { kind: 'direct' },
            },
          },
          cookResumePromptOpen: true,
          cookTaskContent: <div role="dialog">恢复做菜</div>,
        })}
      />,
    );

    expect(screen.getByText('发现内容')).toBeInTheDocument();
    expect(screen.getByRole('dialog')).toHaveTextContent('恢复做菜');
    const background = view.container.querySelector('.eat-workspace-cook-background');
    expect(background).toHaveAttribute('aria-hidden', 'true');
    expect(background).toHaveAttribute('inert');
  });

  it('keeps discovery as the only top-level food view without section tabs', () => {
    const navigation = createNavigationServiceWithFoodTask();
    render(<EatWorkspace {...makeEatProps({ navigation })} />);
    expect(screen.getByText('发现内容')).toBeInTheDocument();
    expect(screen.queryByRole('tablist')).not.toBeInTheDocument();
    expect(screen.queryByText('菜单内容')).not.toBeInTheDocument();
  });

  it('shows a recoverable relation error without a write action', () => {
    render(
      <EatWorkspace
        {...makeEatProps({
          resolvedTask: { kind: 'recipe-food-missing', recipe: makeRecipe() },
        })}
      />,
    );
    expect(screen.getByText('这份做法与家常菜的关联需要修复')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '开始做' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '返回发现' })).toBeInTheDocument();
  });

  it('renders load-error distinctly from not-found copy', () => {
    render(
      <EatWorkspace
        {...makeEatProps({
          resolvedTask: { kind: 'load-error', label: '食物加载失败', retryable: true },
        })}
      />,
    );
    expect(screen.getAllByText('食物加载失败').length).toBeGreaterThan(0);
    expect(screen.getByText(/不一定表示内容已被删除/)).toBeInTheDocument();
    expect(screen.queryByText(/已经不存在/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '返回发现' })).toBeInTheDocument();
  });

  it('still shows not-found wording for food-not-found', () => {
    render(
      <EatWorkspace
        {...makeEatProps({
          resolvedTask: { kind: 'food-not-found', foodId: 'missing' },
        })}
      />,
    );
    expect(screen.getByText('这份家常菜已经不存在')).toBeInTheDocument();
  });

  it('falls back to discovery when a legacy menu base view is restored', () => {
    const navigation = createNavigationService({
      eat: { baseView: 'plan', task: null, discoverSection: 'all' },
    });
    render(<EatWorkspace {...makeEatProps({ navigation })} />);
    expect(screen.getByText('发现内容')).toBeInTheDocument();
    expect(screen.queryByText('菜单内容')).not.toBeInTheDocument();
    expect(navigation.registerBaseViewFocusTarget).toHaveBeenCalled();
  });

  it('does not inject a page-load cook resume entry into Discover', () => {
    const navigation = createNavigationService({
      eat: { baseView: 'discover', task: null, discoverSection: 'all' },
    });
    render(
      <EatWorkspace
        {...makeEatProps({
          navigation,
        })}
      />,
    );
    expect(screen.queryByText('继续做菜入口')).not.toBeInTheDocument();
    expect(screen.getByText('发现内容')).toBeInTheDocument();
  });

  it('does not inject a page-load cook resume entry for a legacy menu base view', () => {
    const navigation = createNavigationService({
      eat: { baseView: 'plan', task: null, discoverSection: 'all' },
    });
    render(
      <EatWorkspace
        {...makeEatProps({
          navigation,
        })}
      />,
    );
    expect(screen.queryByText('继续做菜入口')).not.toBeInTheDocument();
    expect(screen.getByText('发现内容')).toBeInTheDocument();
  });

  it('closes a relation-error task through the return action', async () => {
    const user = userEvent.setup();
    const navigation = createNavigationService({
      eat: {
        baseView: 'discover',
        discoverSection: 'all',
        task: { kind: 'recipe-target', recipeId: 'recipe-1', mode: 'view', returnTo: 'discover' },
      },
    });
    render(
      <EatWorkspace
        {...makeEatProps({
          navigation,
          resolvedTask: { kind: 'recipe-food-missing', recipe: makeRecipe() },
        })}
      />,
    );
    await user.click(screen.getByRole('button', { name: '返回发现' }));
    expect(navigation.closeTask).toHaveBeenCalledTimes(1);
  });

  it('registers the task heading for focus protocol without auto-focusing in an effect', () => {
    const navigation = createNavigationService({
      eat: {
        baseView: 'discover',
        discoverSection: 'all',
        task: { kind: 'recipe-target', recipeId: 'recipe-1', mode: 'view', returnTo: 'discover' },
      },
    });
    render(
      <EatWorkspace
        {...makeEatProps({
          navigation,
          resolvedTask: { kind: 'recipe-food-ambiguous', recipe: makeRecipe(), foodIds: ['a', 'b'] },
        })}
      />,
    );
    expect(navigation.registerTaskHeading).toHaveBeenCalled();
    const heading = screen.getByRole('heading', { name: '这份做法与家常菜的关联需要修复' });
    expect(heading).toHaveAttribute('tabindex', '-1');
    // Shell must not steal focus onto 关闭; Task 2 focuses the registered heading.
    expect(heading).not.toHaveFocus();
    expect(screen.getByRole('button', { name: '关闭' })).not.toHaveFocus();
  });

  it('names the task dialog from the visible heading', () => {
    const navigation = createNavigationService({
      eat: {
        baseView: 'discover',
        discoverSection: 'all',
        task: { kind: 'recipe-target', recipeId: 'recipe-1', mode: 'view', returnTo: 'discover' },
      },
    });
    render(
      <EatWorkspace
        {...makeEatProps({
          navigation,
          resolvedTask: { kind: 'recipe-food-missing', recipe: makeRecipe() },
        })}
      />,
    );
    const dialog = screen.getByRole('dialog', { name: '这份做法与家常菜的关联需要修复' });
    expect(dialog).toBeInTheDocument();
    const heading = screen.getByRole('heading', { name: '这份做法与家常菜的关联需要修复' });
    expect(dialog.getAttribute('aria-labelledby')).toBe(heading.id);
    expect(dialog.getAttribute('aria-label')).toBeNull();
  });

  it('disables relation-error return while completion is pending', () => {
    render(
      <EatWorkspace
        {...makeEatProps({
          resolvedTask: { kind: 'recipe-food-missing', recipe: makeRecipe() },
          completionPending: true,
        })}
      />,
    );
    expect(screen.getByRole('button', { name: '返回发现' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '关闭' })).toBeDisabled();
  });

  it('blocks Escape and backdrop close while completion is pending', async () => {
    const user = userEvent.setup();
    const navigation = createNavigationService({
      eat: {
        baseView: 'discover',
        discoverSection: 'all',
        task: { kind: 'food-detail', foodId: 'food-1', returnTo: 'discover' },
      },
    });
    const resolvedTask: ResolvedEatTask = {
      kind: 'food',
      food: {
        id: 'food-1',
        family_id: 'family-1',
        name: 'Tomato eggs',
        type: 'selfMade',
        category: 'home',
        flavor_tags: [],
        suitable_meal_types: ['dinner'],
        source_name: '',
        purchase_source: '',
        scene: '',
        images: [],
        notes: '',
        routine_note: '',
        stock_unit: '',
        storage_location: '',
        favorite: false,
        recipe_id: 'recipe-1',
        row_version: 1,
        created_at: '2026-07-01T00:00:00.000Z',
        updated_at: '2026-07-01T00:00:00.000Z',
      },
    };

    render(
      <EatWorkspace
        {...makeEatProps({
          navigation,
          resolvedTask,
          completionPending: true,
        })}
      />,
    );

    expect(screen.getByText('家常菜任务内容将由上层装配。')).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(navigation.closeTask).not.toHaveBeenCalled();

    const backdrop = document.querySelector('.workspace-overlay-backdrop');
    expect(backdrop).toBeTruthy();
    await user.click(backdrop as Element);
    expect(navigation.closeTask).not.toHaveBeenCalled();
  });

  it('closes the task on Escape when completion is not pending', async () => {
    const user = userEvent.setup();
    const navigation = createNavigationService({
      eat: {
        baseView: 'discover',
        discoverSection: 'all',
        task: { kind: 'food-detail', foodId: 'food-1', returnTo: 'discover' },
      },
    });
    render(
      <EatWorkspace
        {...makeEatProps({
          navigation,
          resolvedTask: {
            kind: 'food',
            food: {
              id: 'food-1',
              family_id: 'family-1',
              name: 'Tomato eggs',
              type: 'selfMade',
              category: 'home',
              flavor_tags: [],
              suitable_meal_types: ['dinner'],
              source_name: '',
              purchase_source: '',
              scene: '',
              images: [],
              notes: '',
              routine_note: '',
              stock_unit: '',
              storage_location: '',
              favorite: false,
              recipe_id: 'recipe-1',
              row_version: 1,
              created_at: '2026-07-01T00:00:00.000Z',
              updated_at: '2026-07-01T00:00:00.000Z',
            },
          },
        })}
      />,
    );

    await user.keyboard('{Escape}');
    expect(navigation.closeTask).toHaveBeenCalledTimes(1);
  });

  it('renders provided food task content without the empty shell placeholder', () => {
    render(
      <EatWorkspace
        {...makeEatProps({
          resolvedTask: {
            kind: 'food',
            food: {
              id: 'food-1',
              family_id: 'family-1',
              name: 'Tomato eggs',
              type: 'selfMade',
              category: 'home',
              flavor_tags: [],
              suitable_meal_types: ['dinner'],
              source_name: '',
              purchase_source: '',
              scene: '',
              images: [],
              notes: '',
              routine_note: '',
              stock_unit: '',
              storage_location: '',
              favorite: false,
              recipe_id: 'recipe-1',
              row_version: 1,
              created_at: '2026-07-01T00:00:00.000Z',
              updated_at: '2026-07-01T00:00:00.000Z',
            },
          },
          foodTaskContent: <div>食物详情内容</div>,
        })}
      />,
    );
    expect(screen.getByText('食物详情内容')).toBeInTheDocument();
    expect(screen.queryByText('家常菜任务内容将由上层装配。')).not.toBeInTheDocument();
  });

  it('shows recipe-not-found recoverably without write actions', () => {
    render(
      <EatWorkspace
        {...makeEatProps({
          resolvedTask: { kind: 'recipe-not-found', recipeId: 'missing-recipe' },
        })}
      />,
    );
    expect(screen.getByText('这份做法已经不存在')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '开始做' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '返回发现' })).toBeInTheDocument();
  });

  it('announces live messages politely', () => {
    render(<EatWorkspace {...makeEatProps({ liveMessage: '已记录这餐' })} />);
    const live = document.querySelector('[aria-live="polite"]');
    expect(live).toHaveTextContent('已记录这餐');
  });

  it('renders loading and not-found task states without write actions', () => {
    const { rerender } = render(
      <EatWorkspace {...makeEatProps({ resolvedTask: { kind: 'loading', label: '正在加载食物' } })} />,
    );
    expect(screen.getByText('正在加载食物')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '开始做' })).not.toBeInTheDocument();

    rerender(
      <EatWorkspace
        {...makeEatProps({ resolvedTask: { kind: 'meal-not-found', mealLogId: 'meal-x' } })}
      />,
    );
    expect(screen.getByText('这餐记录已经不存在')).toBeInTheDocument();
  });
});
