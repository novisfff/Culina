// @vitest-environment jsdom

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createElement } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { Food, MealLog, MediaAsset, Member } from '../../api/types';
import { MealLogWorkspace } from './MealLogWorkspace';

const mealsDir = resolve(__dirname);

function readSource(fileName: string) {
  return readFileSync(resolve(mealsDir, fileName), 'utf8');
}

const DEBT_LANGUAGE = [
  '基础记录',
  '已丰富',
  '待补充',
  '未评分',
  '手动补录',
  '菜单计划',
  '补充这餐',
  '待补充数量',
  '记录任务',
] as const;

function media(id: string, overrides: Partial<MediaAsset> = {}): MediaAsset {
  return {
    id,
    name: id,
    url: `/media/${id}.jpg`,
    source: 'upload',
    alt: id,
    created_at: '2026-07-15T11:00:00.000Z',
    ...overrides,
  };
}

function mealLog(overrides: Partial<MealLog> = {}): MealLog {
  return {
    id: 'meal-1',
    family_id: 'family-1',
    date: '2026-07-15',
    meal_type: 'dinner',
    food_entries: [
      {
        id: 'entry-1',
        food_id: 'food-1',
        food_name: '番茄炒蛋',
        servings: 1,
        note: '',
        rating: null,
      },
    ],
    participant_user_ids: [],
    notes: '',
    mood: '',
    photos: [],
    deduction_suggestions: [],
    row_version: 1,
    created_at: '2026-07-15T11:00:00.000Z',
    updated_at: '2026-07-15T11:00:00.000Z',
    ...overrides,
  };
}

function food(id: string, name: string, overrides: Partial<Food> = {}): Food {
  return {
    id,
    family_id: 'family-1',
    name,
    type: 'selfMade',
    category: '家常菜',
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
    recipe_id: null,
    row_version: 1,
    created_at: '2026-07-15T00:00:00Z',
    updated_at: '2026-07-15T00:00:00Z',
    ...overrides,
  };
}

const member: Member = {
  id: 'user-1',
  username: 'mom',
  display_name: '妈妈',
  avatar_seed: 'seed',
  role: 'Owner',
  status: 'active',
};

function renderHistory(args: {
  meals?: MealLog[];
  foods?: Food[];
  members?: Member[];
  onRecordMeal?: () => void;
} = {}) {
  const onRecordMeal = args.onRecordMeal ?? vi.fn();
  const view = render(
    createElement(MealLogWorkspace, {
      foodPlanItems: [],
      members: args.members ?? [member],
      recentMeals: args.meals ?? [mealLog()],
      foods: args.foods ?? [food('food-1', '番茄炒蛋', { images: [media('food-cover', { alt: '番茄炒蛋' })] })],
      isUpdatingMeal: false,
      updateMealLog: vi.fn(async () => undefined),
      onBackHome: vi.fn(),
      onBackToEat: vi.fn(),
      onRecordMeal,
    }),
  );
  return { ...view, onRecordMeal };
}

describe('MealLogWorkspace overlay reuse', () => {
  it('uses shared overlay components for meal log modals', () => {
    const source = readSource('MealLogWorkspace.tsx');

    expect(source).toContain('MealEnrichmentModal');
    expect(source).toContain('MealHistorySurface');
    expect(source).toContain('WorkspaceOverlayFrame');
    expect(source).not.toContain('<div className="workspace-overlay-root"');
    expect(source).not.toContain('<div className="workspace-overlay-backdrop"');
  });

  it('keeps MealHistorySurface free of debt-task language', () => {
    const historySource = readSource('MealHistorySurface.tsx');
    const modelSource = readSource('MealLogWorkspaceModel.ts');
    const mobileSource = readSource('MealLogMobileView.tsx');
    const workspaceSource = readSource('MealLogWorkspace.tsx');
    const enrichmentModalSource = readSource('MealEnrichmentModal.tsx');
    const enrichmentSource = readSource('MealLogEnrichment.tsx');

    expect(historySource).toContain('export function MealHistorySurface');
    for (const phrase of DEBT_LANGUAGE) {
      expect(historySource).not.toContain(phrase);
      expect(modelSource).not.toContain(phrase);
      expect(mobileSource).not.toContain(phrase);
      expect(workspaceSource).not.toContain(phrase);
      expect(enrichmentModalSource).not.toContain(phrase);
      expect(enrichmentSource).not.toContain(phrase);
    }
  });

  it('does not keep the legacy meal enrichment inline footer', () => {
    const enrichmentSource = readFileSync(resolve(__dirname, './MealLogEnrichment.tsx'), 'utf8');
    const mealLogStyles = readFileSync(resolve(__dirname, '../../styles/08-meal-log.css'), 'utf8');

    for (const className of ['meal-enrichment-footer', 'meal-enrichment-footer button']) {
      expect(enrichmentSource).not.toContain(className);
      expect(mealLogStyles).not.toContain(className);
    }
  });

  it('lets shared modal footers own meal log action layout', () => {
    const mealLogStyles = readFileSync(resolve(__dirname, '../../styles/08-meal-log.css'), 'utf8');

    expect(mealLogStyles).toContain('.meal-log-preview-modal-actions button');
    expect(mealLogStyles).not.toContain('.meal-log-preview-modal-actions .ui-form-actions-row');
    expect(mealLogStyles).not.toContain('.meal-log-preview-modal-actions .ui-form-actions-spacer');
    expect(mealLogStyles).not.toContain('.meal-enrichment-actions .ui-form-actions-row');
    expect(mealLogStyles).not.toContain('.meal-enrichment-actions .ui-form-actions-spacer');
  });

  it('keeps meal photo lightbox transition styling in CSS', () => {
    const enrichmentSource = readFileSync(resolve(__dirname, './MealLogEnrichment.tsx'), 'utf8');
    const mealLogStyles = readFileSync(resolve(__dirname, '../../styles/08-meal-log.css'), 'utf8');

    expect(enrichmentSource).not.toContain('transition: isDragging');
    expect(mealLogStyles).toContain('.meal-photo-lightbox-viewport img');
    expect(mealLogStyles).toContain('transition: transform 0.2s cubic-bezier(0.16, 1, 0.3, 1)');
    expect(mealLogStyles).toContain('.meal-photo-lightbox-viewport.grabbing img');
    expect(mealLogStyles).toContain('transition: none');
  });
});

describe('MealLogWorkspace photo-first timeline', () => {
  it('renders only meaningful meal facts and photo-first content', () => {
    const mealWithoutOptionalFields = mealLog({
      photos: [],
      notes: '',
      mood: '',
      participant_user_ids: [],
      food_entries: [
        {
          id: 'entry-1',
          food_id: 'food-1',
          food_name: '番茄炒蛋',
          servings: 1,
          note: '',
          rating: null,
        },
      ],
    });
    const foodWithCover = food('food-1', '番茄炒蛋', {
      images: [media('food-cover', { alt: '番茄炒蛋' })],
    });

    renderHistory({ meals: [mealWithoutOptionalFields], foods: [foodWithCover] });

    expect(screen.getAllByRole('heading', { name: '吃过的' }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole('button', { name: '记一餐' }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole('img', { name: /番茄炒蛋/ }).length).toBeGreaterThan(0);

    for (const debt of DEBT_LANGUAGE) {
      expect(screen.queryByText(debt)).not.toBeInTheDocument();
    }
    expect(screen.queryByLabelText('记录丰富度筛选')).not.toBeInTheDocument();
  });

  it('prefers MealLog photo over Food cover and shows +N for extra photos', () => {
    const meal = mealLog({
      photos: [
        media('meal-photo-1', { alt: '番茄炒蛋' }),
        media('meal-photo-2', { alt: '第二张' }),
        media('meal-photo-3', { alt: '第三张' }),
      ],
      food_entries: [
        { id: 'e1', food_id: 'food-1', food_name: '番茄炒蛋', servings: 1, note: '', rating: 4.5 },
        { id: 'e2', food_id: 'food-2', food_name: '青菜', servings: 1, note: '', rating: null },
      ],
      participant_user_ids: ['user-1'],
      created_by: 'user-1',
    });
    renderHistory({
      meals: [meal],
      foods: [
        food('food-1', '番茄炒蛋', { images: [media('food-cover', { alt: '封面不该优先' })] }),
        food('food-2', '青菜'),
      ],
    });

    expect(screen.getAllByRole('img', { name: /番茄炒蛋/ }).length).toBeGreaterThan(0);
    expect(screen.getAllByText('+2').length).toBeGreaterThan(0);
    expect(screen.getAllByText(/4\.5/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/1 人|妈妈/).length).toBeGreaterThan(0);
  });

  it('uses independent desktop and mobile structures with memory slot', () => {
    renderHistory();
    expect(document.querySelector('.meal-log-desktop-view')).not.toBeNull();
    expect(document.querySelector('.mobile-log-page')).not.toBeNull();
    expect(document.querySelectorAll('[data-memory-slot="true"]').length).toBeGreaterThan(0);
  });

  it('opens 这餐详情 and offers optional 编辑这顿', async () => {
    const user = userEvent.setup();
    renderHistory({
      meals: [
        mealLog({
          photos: [media('meal-photo', { alt: '番茄炒蛋' })],
          notes: '味道不错',
        }),
      ],
    });

    const rows = screen.getAllByRole('button', { name: /番茄炒蛋/ });
    await user.click(rows[0]!);
    expect(await screen.findByRole('heading', { name: '这餐详情' })).toBeVisible();
    expect(screen.getByRole('button', { name: '编辑这顿' })).toBeVisible();
    expect(screen.queryByText('补充这餐')).not.toBeInTheDocument();
  });

  it('shows empty state without source labels when search misses', async () => {
    const user = userEvent.setup();
    renderHistory({ meals: [mealLog()] });
    const search = screen.getAllByPlaceholderText(/搜索/)[0]!;
    await user.type(search, '不存在的菜');
    expect(screen.getAllByText(/没有符合条件的记录|没有找到/).length).toBeGreaterThan(0);
    for (const debt of ['手动补录', '菜单计划', '基础记录']) {
      expect(screen.queryByText(debt)).not.toBeInTheDocument();
    }
  });
});
