// @vitest-environment jsdom

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { Recipe } from '../../api/types';
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
    planContent: <div>菜单内容</div>,
    historyContent: <div>吃过的内容</div>,
    ...overrides,
  };
}

describe('EatWorkspace', () => {
  it('switches base views through tab semantics and closes the current task', async () => {
    const user = userEvent.setup();
    const navigation = createNavigationServiceWithFoodTask();
    render(<EatWorkspace {...makeEatProps({ navigation })} />);
    expect(screen.getByRole('tab', { name: '发现' })).toHaveAttribute('aria-selected', 'true');
    await user.click(screen.getByRole('tab', { name: '菜单' }));
    expect(navigation.selectEatView).toHaveBeenCalledWith('plan', expect.anything());
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

  it('renders the selected base view content and registers the base focus target', () => {
    const navigation = createNavigationService({
      eat: { baseView: 'plan', task: null, discoverSection: 'all' },
    });
    render(<EatWorkspace {...makeEatProps({ navigation })} />);
    expect(screen.getByText('菜单内容')).toBeInTheDocument();
    expect(screen.queryByText('发现内容')).not.toBeInTheDocument();
    expect(navigation.registerBaseViewFocusTarget).toHaveBeenCalled();
    expect(screen.getByRole('tab', { name: '菜单' })).toHaveAttribute('aria-selected', 'true');
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
