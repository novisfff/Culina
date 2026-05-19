import { useEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent } from 'react';
import { API_BASE_URL } from '../../api/client';
import type {
  AiQueryResponse,
  AiRecipeDraft,
  CookRecipePreviewResponse,
  CookRecipeRequest,
  CookRecipeResponse,
  CreateRecipePayload,
  Difficulty,
  Food,
  ImageInputValue,
  Ingredient,
  InventoryItem,
  MealLog,
  MealType,
  Recipe,
  RecipeDiscovery,
  RecipeFavorite,
  RecipeIngredient,
  RecipePlanItem,
  RecipePayload,
  RecipeScene,
  RecipeStats,
  RecipeStep,
  ShoppingListItem,
} from '../../api/types';
import {
  generateImageFromText,
  regenerateImageFromReference,
  uploadReferenceAndGenerateImage,
  type AiImageGenerationError,
  type AiRenderPayload,
} from '../../lib/aiImages';
import { buildIngredientPlaceholderSvg, emptyImages, formatDate, formatDateTime, getImagePreview, MEAL_TYPE_LABELS, splitTags, todayKey } from '../../lib/ui';
import {
  ActionButton,
  Badge,
  EmptyState,
  WorkspaceModal,
  WorkspaceSubpageHeader,
  WorkspaceSubpageShell,
} from '../ui-kit';
import {
  DIFFICULTY_LABELS,
  buildRecipeHomeViewModel,
  buildRecipeCards,
  filterRecipeCards,
  addDateKeyDays,
  getRecipeSceneFilters,
  getRecipeWeekRange,
  type RecipeCardViewModel,
  type RecipeQuickFilter,
  type RecipeSortMode,
  type RecipeWorkspaceView,
} from './workspaceModel';

export type RecipeDraftIngredient = RecipeIngredient;

type RecipeStepDraft = {
  id: string;
  title: string;
  text: string;
  icon: string;
  summary: string;
  estimatedMinutes: string;
  tip: string;
  keyPoints: string;
};

export type RecipeFormState = {
  title: string;
  servings: string;
  prepMinutes: string;
  difficulty: Difficulty;
  steps: RecipeStepDraft[];
  tips: string;
  sceneTags: string;
  images: ImageInputValue;
  autoCreateFood: boolean;
};

type ManagedRecipeScene = {
  id?: string;
  name: string;
  description: string;
  imagePrompt: string;
  imageAssetId?: string;
  imageAssetUrl?: string;
  hidden?: boolean;
  custom?: boolean;
};

type RecipeSceneCard = {
  name: string;
  count: number;
  description?: string;
  imagePrompt?: string;
  imageAssetId?: string;
  imageAssetUrl?: string;
  custom?: boolean;
};

type ImageGenerationUiState = {
  isGenerating: boolean;
  errorMessage: string | null;
};

type RecipeDraftAiFormState = {
  prompt: string;
  ingredientIds: string[];
};

type RecipeSceneFormMode = 'create' | 'edit' | null;
type RecipeShoppingDraftSource = 'shortage' | 'existing' | 'custom';
export type RecipeShoppingRequirement = 'required' | 'optional';
export type RecipeShoppingDraftItem = {
  id: string;
  title: string;
  quantity: string;
  unit: string;
  reason: string;
  source: RecipeShoppingDraftSource;
  requirement: RecipeShoppingRequirement;
  recipeIngredientId?: string;
};

type RecipeShoppingCustomForm = {
  title: string;
  quantity: string;
  unit: string;
};

type RecipeNotice = {
  tone: 'success' | 'warning' | 'danger';
  title: string;
  message: string;
};

export type RecipeCookSessionState = {
  currentStepIndex: number;
  checkedIngredientIds: string[];
  completedStepIds: string[];
  timerSeconds: number;
  timerRunning: boolean;
  timerMode: 'countup' | 'countdown';
  timerDurationSeconds: number | null;
  servings: string;
  date: string;
  mealType: MealType;
  createMealLog: boolean;
  planItemId: string | null;
  adjustments: string;
  resultNote: string;
  rating: string;
};

type RecipeShoppingIngredientOption = {
  id: string;
  name: string;
  unit: string;
  imageUrl: string;
  category: string;
};

type RecipeWorkspaceProps = {
  recipes: Recipe[];
  ingredients: Ingredient[];
  inventoryItems: InventoryItem[];
  mealLogs: MealLog[];
  foods: Food[];
  shoppingItems: ShoppingListItem[];
  recipeFavorites: RecipeFavorite[];
  recipeDiscovery: RecipeDiscovery | null;
  recipeStats: RecipeStats | null;
  recipePlanItems: RecipePlanItem[];
  recipeScenes: RecipeScene[];
  recipePlanWeekRange: { start: string; end: string };
  onRecipePlanPreviousWeek: () => void;
  onRecipePlanCurrentWeek: () => void;
  onRecipePlanNextWeek: () => void;
  createRecipe: (payload: CreateRecipePayload) => Promise<Recipe>;
  updateRecipe: (recipeId: string, payload: RecipePayload) => Promise<Recipe>;
  deleteRecipe: (recipeId: string) => Promise<void>;
  cookRecipe: (recipeId: string, payload: CookRecipeRequest) => Promise<CookRecipeResponse>;
  previewCookRecipe: (recipeId: string, payload: CookRecipeRequest) => Promise<CookRecipePreviewResponse>;
  queryAi: (payload: { mode: 'recipeDraft'; prompt: string; ingredient_ids: string[] }) => Promise<AiQueryResponse>;
  createShoppingItem: (payload: { title: string; quantity: number; unit: string; reason: string }) => Promise<ShoppingListItem>;
  addRecipeFavorite: (recipeId: string) => Promise<RecipeFavorite>;
  removeRecipeFavorite: (recipeId: string) => Promise<void>;
  createRecipePlanItem: (payload: { recipe_id: string; plan_date: string; meal_type: MealType; note: string }) => Promise<RecipePlanItem>;
  updateRecipePlanItem: (itemId: string, payload: { recipe_id?: string; plan_date?: string; meal_type?: MealType; note?: string }) => Promise<RecipePlanItem>;
  deleteRecipePlanItem: (itemId: string) => Promise<void>;
  createRecipeScene: (payload: {
    name: string;
    description: string;
    image_prompt: string;
    image_asset_id?: string;
    hidden: boolean;
    custom: boolean;
    sort_order: number;
  }) => Promise<RecipeScene>;
  updateRecipeScene: (
    sceneId: string,
    payload: {
      name?: string;
      description?: string;
      image_prompt?: string;
      image_asset_id?: string;
      hidden?: boolean;
      custom?: boolean;
      sort_order?: number;
    }
  ) => Promise<RecipeScene>;
  deleteRecipeScene: (sceneId: string) => Promise<void>;
  isCreatingRecipe?: boolean;
  isUpdatingRecipe?: boolean;
  isDeletingRecipe?: boolean;
  isCookingRecipe?: boolean;
  isCreatingShopping?: boolean;
  isUpdatingFavorite?: boolean;
  isUpdatingPlan?: boolean;
  isUpdatingScene?: boolean;
};

const QUICK_FILTERS: Array<{ value: RecipeQuickFilter; label: string }> = [
  { value: 'recommend', label: '为你推荐' },
  { value: 'all', label: '全部' },
  { value: 'ready', label: '可做' },
  { value: 'quick', label: '快手' },
  { value: 'common', label: '常做' },
  { value: 'favorite', label: '收藏' },
  { value: 'missing', label: '缺料' },
];
const SORT_OPTIONS: Array<{ value: RecipeSortMode; label: string }> = [
  { value: 'updated', label: '最近更新' },
  { value: 'availability', label: '匹配度' },
  { value: 'time', label: '准备时长' },
  { value: 'difficulty', label: '难度' },
];
const MEAL_TYPE_OPTIONS: Array<{ value: MealType; label: string }> = [
  { value: 'breakfast', label: '早餐' },
  { value: 'lunch', label: '午餐' },
  { value: 'dinner', label: '晚餐' },
  { value: 'snack', label: '加餐' },
];
const SHOPPING_UNIT_OPTIONS = ['个', '颗', '盒', '袋', '斤', '克', '瓶', '把', '份', '片'];
const FALLBACK_SCENES = ['工作日晚餐', '孩子也能吃', '周末轻食', '高蛋白', '早餐', '汤羹'];
const DUPLICATED_TYPE_LABELS = new Set(['全部', '为你推荐', '快手', '快手菜', '下饭菜', '缺料', '可做', '常做', '家常菜']);
const IDLE_IMAGE_GENERATION_STATE: ImageGenerationUiState = { isGenerating: false, errorMessage: null };
const OPTIONAL_INGREDIENT_NOTE_PATTERN = /^(?:可选|选用|装饰|替代|没有可不放)[：:\s、，,]*/;
const MAX_STEP_KEY_POINTS = 3;

const DISCOVERY_SECTION_COPY: Record<RecipeQuickFilter, { title: string; description: string; emptyTitle: string; emptyDescription: string }> = {
  all: {
    title: '全部菜谱',
    description: '按当前筛选条件浏览所有菜谱',
    emptyTitle: '没有匹配的菜谱',
    emptyDescription: '换个搜索或筛选条件试试。',
  },
  recommend: {
    title: '为你推荐',
    description: '根据你的口味和习惯推荐',
    emptyTitle: '还没有可推荐的菜谱',
    emptyDescription: '先新增几份常做菜，之后会按库存和记录推荐。',
  },
  ready: {
    title: '可做菜谱',
    description: '优先展示当前库存更容易安排的菜谱',
    emptyTitle: '暂无可做菜谱',
    emptyDescription: '补充库存后，可直接做的菜谱会显示在这里。',
  },
  quick: {
    title: '快手',
    description: '适合 20 分钟内快速开饭',
    emptyTitle: '暂无快手菜',
    emptyDescription: '把准备时长设置在 20 分钟以内，就会归入快手菜。',
  },
  common: {
    title: '常做',
    description: '来自收藏、常做和高频餐食记录',
    emptyTitle: '暂无常做菜谱',
    emptyDescription: '收藏或多记录几次常吃菜谱后会自动聚合。',
  },
  favorite: {
    title: '我的收藏',
    description: '你收藏过、想优先安排的菜谱',
    emptyTitle: '还没有收藏菜谱',
    emptyDescription: '点亮菜谱卡片上的收藏，之后会集中显示在这里。',
  },
  missing: {
    title: '缺料菜谱',
    description: '这些菜谱需要先补齐部分食材',
    emptyTitle: '当前没有缺料菜谱',
    emptyDescription: '库存充足时这里会变少，可以切回为你推荐。',
  },
};

function newDraftId(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

const RECIPE_STEP_ICON_OPTIONS = [
  { value: 'pan', label: '炒锅' },
  { value: 'tomato', label: '食材' },
  { value: 'bowl', label: '调味' },
  { value: 'timer', label: '计时' },
  { value: 'tip', label: '提示' },
  { value: 'plate', label: '出锅' },
];

const COOK_TIMER_PRESETS = [
  { label: '正计时', seconds: null },
  { label: '自定义', seconds: 'custom' as const },
  { label: '30秒', seconds: 30 },
  { label: '1分钟', seconds: 60 },
  { label: '2分钟', seconds: 120 },
  { label: '3分钟', seconds: 180 },
  { label: '5分钟', seconds: 300 },
  { label: '10分钟', seconds: 600 },
];

function createEmptyRecipeStepDraft(id = newDraftId('step')): RecipeStepDraft {
  return {
    id,
    title: '',
    text: '',
    icon: 'pan',
    summary: '',
    estimatedMinutes: '',
    tip: '',
    keyPoints: '',
  };
}

function buildRecipeStepDraft(step: RecipeStep): RecipeStepDraft {
  return {
    id: step.id,
    title: step.title || '',
    text: step.text,
    icon: step.icon || 'pan',
    summary: step.summary || '',
    estimatedMinutes: step.estimated_minutes ? String(step.estimated_minutes) : '',
    tip: step.tip || '',
    keyPoints: (step.key_points ?? []).join('\n'),
  };
}

function defaultRecipeForm(): RecipeFormState {
  return {
    title: '',
    servings: '2',
    prepMinutes: '20',
    difficulty: 'easy',
    steps: [createEmptyRecipeStepDraft('step-1')],
    tips: '',
    sceneTags: '',
    images: emptyImages(),
    autoCreateFood: true,
  };
}

function defaultIngredientRows(): RecipeDraftIngredient[] {
  return [{ id: 'draft-1', ingredient_name: '', ingredient_id: '', quantity: 1, unit: '个', note: '' }];
}

function buildFormFromRecipe(recipe: Recipe): { form: RecipeFormState; ingredients: RecipeDraftIngredient[] } {
  return {
    form: {
      title: recipe.title,
      servings: String(recipe.servings),
      prepMinutes: String(recipe.prep_minutes),
      difficulty: recipe.difficulty,
      steps: recipe.steps.length > 0 ? recipe.steps.map(buildRecipeStepDraft) : [createEmptyRecipeStepDraft('step-1')],
      tips: recipe.tips,
      sceneTags: recipe.scene_tags.join('，'),
      images: recipe.images[0] ? { generatedAsset: recipe.images[0] } : emptyImages(),
      autoCreateFood: false,
    },
    ingredients:
      recipe.ingredient_items.length > 0
        ? recipe.ingredient_items.map((item) => ({ ...item }))
        : defaultIngredientRows(),
  };
}

function mapRecipeScene(scene: RecipeScene): ManagedRecipeScene {
  return {
    id: scene.id,
    name: scene.name,
    description: scene.description,
    imagePrompt: scene.image_prompt,
    imageAssetId: scene.image?.id,
    imageAssetUrl: scene.image?.url,
    hidden: scene.hidden,
    custom: scene.custom,
  };
}

function defaultSceneDraft(): ManagedRecipeScene {
  return { name: '', description: '', imagePrompt: '', custom: true };
}

function resolveAssetUrl(url?: string) {
  if (!url) return undefined;
  if (url.startsWith('http://') || url.startsWith('https://') || url.startsWith('data:')) return url;
  return `${API_BASE_URL}${url}`;
}

function resolveIngredientImageUrl(ingredient: Ingredient | null | undefined, fallbackName: string) {
  return resolveAssetUrl(ingredient?.image?.url) ?? buildIngredientPlaceholderSvg(fallbackName || ingredient?.name || '食材');
}

function resolveErrorMessage(reason: unknown, fallback: string) {
  return reason instanceof Error && reason.message.trim() ? reason.message : fallback;
}

function extractReferenceAsset(reason: unknown): ImageInputValue['referenceAsset'] {
  if (reason && typeof reason === 'object' && 'referenceAsset' in reason) {
    return (reason as AiImageGenerationError).referenceAsset;
  }
  return undefined;
}

function getRecipeMediaIds(images: ImageInputValue) {
  return images.generatedAsset ? [images.generatedAsset.id] : [];
}

type RecipeUiIconName =
  | 'basket'
  | 'calendar'
  | 'check'
  | 'chevronDown'
  | 'chevronLeft'
  | 'chevronRight'
  | 'clock'
  | 'clipboard'
  | 'edit'
  | 'filter'
  | 'flame'
  | 'heart'
  | 'image'
  | 'info'
  | 'leaf'
  | 'minus'
  | 'pause'
  | 'play'
  | 'plus'
  | 'plusThirty'
  | 'reset'
  | 'search'
  | 'signal'
  | 'sparkle'
  | 'star'
  | 'tag'
  | 'utensils'
  | 'users'
  | 'view'
  | 'warning'
  | 'zap';

function RecipeUiIcon(props: { name: RecipeUiIconName; className?: string }) {
  const common = {
    viewBox: '0 0 24 24',
    'aria-hidden': true,
    className: props.className ? `recipe-ui-icon ${props.className}` : 'recipe-ui-icon',
  };

  switch (props.name) {
    case 'basket':
      return (
        <svg {...common}>
          <path d="M8 10.2 10.2 5M16 10.2 13.8 5" />
          <path d="M5.2 10.2h13.6l-1.3 8.1a2.2 2.2 0 0 1-2.2 1.9H8.7a2.2 2.2 0 0 1-2.2-1.9l-1.3-8.1Z" />
          <path d="M4 10.2h16M9.2 14v2.8M12 14v2.8M14.8 14v2.8" />
        </svg>
      );
    case 'calendar':
      return (
        <svg {...common}>
          <path d="M7 4v3M17 4v3M5.5 9.5h13" />
          <rect x="4.5" y="6.5" width="15" height="13" rx="3" />
          <path d="M8 13h.01M12 13h.01M16 13h.01M8 16h.01M12 16h.01" />
        </svg>
      );
    case 'check':
      return (
        <svg {...common}>
          <path d="m5.5 12.4 4.1 4.1 8.9-9" />
        </svg>
      );
    case 'chevronDown':
      return (
        <svg {...common}>
          <path d="m7 9.5 5 5 5-5" />
        </svg>
      );
    case 'chevronLeft':
      return (
        <svg {...common}>
          <path d="m14.5 6-6 6 6 6" />
        </svg>
      );
    case 'chevronRight':
      return (
        <svg {...common}>
          <path d="m9.5 6 6 6-6 6" />
        </svg>
      );
    case 'clock':
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="7.2" />
          <path d="M12 7.8v4.6l3.1 1.9" />
        </svg>
      );
    case 'clipboard':
      return (
        <svg {...common}>
          <path d="M9 5.5h6M9.4 4.2h5.2a1.4 1.4 0 0 1 1.4 1.4v1H8v-1a1.4 1.4 0 0 1 1.4-1.4Z" />
          <path d="M7.4 6.5H6.3a2 2 0 0 0-2 2v10.1a2 2 0 0 0 2 2h11.4a2 2 0 0 0 2-2V8.5a2 2 0 0 0-2-2h-1.1" />
          <path d="M8.2 12h7.6M8.2 15.5h5.4" />
        </svg>
      );
    case 'edit':
      return (
        <svg {...common}>
          <path d="M4.8 16.9 4 20l3.1-.8L18.5 7.8a2.1 2.1 0 0 0-3-3L4.8 16.9Z" />
          <path d="m14.3 6 3.2 3.2M11.5 20h7.2" />
        </svg>
      );
    case 'filter':
      return (
        <svg {...common}>
          <path d="M5 6.5h14l-5.3 6.1v4.3l-3.4 1.8v-6.1L5 6.5Z" />
        </svg>
      );
    case 'flame':
      return (
        <svg {...common}>
          <path d="M12.6 3.8c.4 2.7-1.4 4.1-2.8 5.9-1.1 1.4-1.9 2.8-1.9 4.7 0 3.4 2.6 5.8 5.9 5.8s5.9-2.3 5.9-5.8c0-2.5-1.5-4.8-4.1-7.4-.4 2-1.7 3.2-3.1 4.3" />
          <path d="M12.3 14.4c-.7 1-.8 2.1-.1 3 .4.6 1.1.9 1.9.9 1.4 0 2.4-1 2.4-2.5 0-1.1-.6-2.1-1.6-3.1-.4.9-1 1.4-1.7 1.8" />
        </svg>
      );
    case 'heart':
      return (
        <svg {...common}>
          <path d="M12 20.2 5.1 13.6C2.9 11.5 2.8 8 4.8 6c1.9-1.9 5-1.7 6.7.4l.5.6.5-.6c1.7-2.1 4.8-2.3 6.7-.4 2 2 1.9 5.5-.3 7.6L12 20.2Z" />
        </svg>
      );
    case 'image':
      return (
        <svg {...common}>
          <rect x="4" y="5" width="16" height="14" rx="2.4" />
          <path d="m7.5 16 3.4-3.4 2.4 2.4 2.1-2.1L19 16.5" />
          <circle cx="8.7" cy="9" r="1.2" />
        </svg>
      );
    case 'info':
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="8.2" />
          <path d="M12 10.8v5.1M12 8.1h.01" />
        </svg>
      );
    case 'leaf':
      return (
        <svg {...common}>
          <path d="M5.3 13.1c0-5.2 5.1-8.1 12.9-8.7-.4 7.8-3.5 12.8-8.7 12.8-2.5 0-4.2-1.7-4.2-4.1Z" />
          <path d="M8.3 14.8c2.4-2.7 5-4.7 8.3-6.2" />
        </svg>
      );
    case 'plus':
      return (
        <svg {...common}>
          <path d="M12 5v14M5 12h14" />
        </svg>
      );
    case 'minus':
      return (
        <svg {...common}>
          <path d="M5 12h14" />
        </svg>
      );
    case 'pause':
      return (
        <svg {...common}>
          <path d="M9 6.5v11M15 6.5v11" />
        </svg>
      );
    case 'play':
      return (
        <svg {...common}>
          <path d="M8 5.8v12.4l10-6.2L8 5.8Z" />
        </svg>
      );
    case 'search':
      return (
        <svg {...common}>
          <circle cx="10.8" cy="10.8" r="5.8" />
          <path d="m15.2 15.2 4 4" />
        </svg>
      );
    case 'plusThirty':
      return (
        <svg {...common}>
          <circle cx="11" cy="12" r="6.2" />
          <path d="M11 8.8v3.4l2.4 1.4" />
          <path d="M4.6 12h2.2M11 5.8v2.1" />
          <path d="M17 5.1v2.3M15.9 6.2h2.3" />
          <path d="M16.2 14.9v4.2M14.1 17h4.2" />
        </svg>
      );
    case 'reset':
      return (
        <svg {...common}>
          <path d="M5.1 8.5A7.2 7.2 0 1 1 4.8 16" />
          <path d="M5 4.8v3.7h3.7" />
        </svg>
      );
    case 'signal':
      return (
        <svg {...common}>
          <path d="M5.5 18.5h2.2v-4.2H5.5v4.2ZM10.9 18.5h2.2V9.7h-2.2v8.8ZM16.3 18.5h2.2V5.5h-2.2v13Z" />
        </svg>
      );
    case 'sparkle':
      return (
        <svg {...common}>
          <path d="M12 3.8 14 9l5.2 2-5.2 2-2 5.2-2-5.2-5.2-2 5.2-2L12 3.8Z" />
        </svg>
      );
    case 'star':
      return (
        <svg {...common}>
          <path d="m12 4.2 2.4 4.9 5.4.8-3.9 3.8.9 5.4-4.8-2.5-4.8 2.5.9-5.4-3.9-3.8 5.4-.8L12 4.2Z" />
        </svg>
      );
    case 'tag':
      return (
        <svg {...common}>
          <path d="M4.8 11.7V5.2h6.5l8.1 8.1a2.1 2.1 0 0 1 0 3l-3.1 3.1a2.1 2.1 0 0 1-3 0L4.8 11.7Z" />
          <path d="M8.1 8.1h.01" />
        </svg>
      );
    case 'utensils':
      return (
        <svg {...common}>
          <path d="M7.2 4.5v6.2M4.8 4.5v6.2M9.6 4.5v6.2M4.8 10.7h4.8M7.2 10.7v8.8M15.2 4.5c2.2 1.6 3.3 3.5 3.3 5.8 0 2.2-1.1 3.8-3.3 4.8v4.4" />
        </svg>
      );
    case 'users':
      return (
        <svg {...common}>
          <path d="M9.6 11.1a3.1 3.1 0 1 0 0-6.2 3.1 3.1 0 0 0 0 6.2Z" />
          <path d="M3.9 19.1c.5-3.1 2.5-5 5.7-5s5.2 1.9 5.7 5" />
          <path d="M15.5 11.3a2.6 2.6 0 1 0-.5-5.1M17 14.2c1.8.6 2.9 2.2 3.1 4.7" />
        </svg>
      );
    case 'view':
      return (
        <svg {...common}>
          <path d="M3.8 12s3-5.2 8.2-5.2 8.2 5.2 8.2 5.2-3 5.2-8.2 5.2S3.8 12 3.8 12Z" />
          <circle cx="12" cy="12" r="2.4" />
        </svg>
      );
    case 'warning':
      return (
        <svg {...common}>
          <path d="M12 4.2 21 19H3L12 4.2Z" />
          <path d="M12 9.3v4.4M12 16.6h.01" />
        </svg>
      );
    case 'zap':
      return (
        <svg {...common}>
          <path d="m13.3 3-7 10h5.2L10.7 21l7-10h-5.2L13.3 3Z" />
        </svg>
      );
  }
}

function getRecipeVisualTone(recipeId: string) {
  const tones = ['tomato', 'fish', 'greens', 'egg'] as const;
  const score = [...recipeId].reduce((total, char) => total + char.charCodeAt(0), 0);
  return tones[score % tones.length];
}

function RecipeDishIllustration(props: { title: string; tone: ReturnType<typeof getRecipeVisualTone> }) {
  return (
    <span className={`recipe-cover-illustration tone-${props.tone}`} aria-label={props.title}>
      <svg viewBox="0 0 160 120" aria-hidden="true">
        <path className="blob blob-a" d="M0 0h160v120H0z" />
        <circle className="accent accent-a" cx="32" cy="28" r="25" />
        <circle className="accent accent-b" cx="122" cy="30" r="20" />
        <path className="plate" d="M36 77c0-20 18-36 44-36s44 16 44 36v17H36V77Z" />
        <path className="plate-line" d="M53 76c0-12 11-21 27-21s27 9 27 21" />
        <circle className="food food-a" cx="60" cy="58" r="15" />
        <path className="food food-b" d="M88 43c17 4 28 14 28 25-17 2-31-3-39-16 3-5 6-8 11-9Z" />
        <path className="garnish" d="M102 48c4-11 11-16 23-18-1 11-8 18-20 21" />
      </svg>
      <small>{props.title}</small>
    </span>
  );
}

export function buildRecipePayload(form: RecipeFormState, rows: RecipeDraftIngredient[], ingredients: Ingredient[]): RecipePayload {
  return {
    title: form.title.trim(),
    servings: Number(form.servings),
    prep_minutes: Number(form.prepMinutes),
    difficulty: form.difficulty,
    ingredient_items: rows
      .filter((item) => item.ingredient_id || item.ingredient_name.trim())
      .map((item) => {
        const ingredient = ingredients.find((entry) => entry.id === item.ingredient_id);
        return {
          ingredient_id: item.ingredient_id || null,
          ingredient_name: ingredient?.name ?? item.ingredient_name.trim(),
          quantity: Number(item.quantity),
          unit: item.unit.trim() || ingredient?.default_unit || '个',
          note: item.note.trim(),
        };
      }),
    steps: form.steps
      .map((step) => ({
        title: step.title.trim(),
        text: step.text.trim(),
        icon: step.icon.trim() || 'pan',
        summary: step.summary.trim(),
        estimated_minutes: step.estimatedMinutes.trim() ? Number(step.estimatedMinutes) : null,
        tip: step.tip.trim(),
        key_points: splitTags(step.keyPoints),
      }))
      .filter((step) => step.text),
    tips: form.tips.trim(),
    scene_tags: splitTags(form.sceneTags),
    media_ids: getRecipeMediaIds(form.images),
  };
}

function formatCookQuantity(value: number) {
  return Number(value.toFixed(2)).toString().replace(/\.0+$/, '');
}

function formatShoppingQuantity(value: number) {
  return Number(value.toFixed(2)).toString().replace(/\.0+$/, '');
}

function formatCookTimer(seconds: number) {
  const safeSeconds = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(safeSeconds / 60);
  const restSeconds = safeSeconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(restSeconds).padStart(2, '0')}`;
}

function getStepSuggestedSeconds(step: Pick<RecipeStep, 'estimated_minutes'> | null | undefined) {
  return step?.estimated_minutes && step.estimated_minutes > 0 ? Math.round(step.estimated_minutes * 60) : null;
}

function formatCookTimerDuration(seconds: number | null | undefined) {
  if (!seconds || seconds <= 0) return '未设置';
  const minutes = Math.floor(seconds / 60);
  const restSeconds = seconds % 60;
  if (minutes <= 0) return `${restSeconds}秒`;
  return restSeconds ? `${minutes}分${String(restSeconds).padStart(2, '0')}秒` : `${minutes}分钟`;
}

function getRecipeStepTitle(step: Partial<Pick<RecipeStep, 'title'>>, index: number) {
  return step.title?.trim() || `步骤 ${index + 1}`;
}

function getRecipeStepSummary(step: Partial<Pick<RecipeStep, 'summary' | 'text'>>) {
  return step.summary?.trim() || step.text?.trim() || '';
}

function getRecipeStepIconName(icon: string | undefined): RecipeUiIconName {
  switch (icon) {
    case 'timer':
      return 'clock';
    case 'tip':
      return 'sparkle';
    case 'plate':
      return 'check';
    case 'tomato':
      return 'leaf';
    case 'bowl':
      return 'basket';
    case 'pan':
    default:
      return 'utensils';
  }
}

function clampStepIndex(index: number, stepCount: number) {
  return Math.min(Math.max(index, 0), Math.max(stepCount - 1, 0));
}

function recipeCookSessionKey(recipeId: string) {
  return `culina-recipe-cook-session:${recipeId}`;
}

function buildDefaultCookSession(recipe: Pick<Recipe, 'servings'>, planItemId: string | null = null): RecipeCookSessionState {
  return {
    currentStepIndex: 0,
    checkedIngredientIds: [],
    completedStepIds: [],
    timerSeconds: 0,
    timerRunning: false,
    timerMode: 'countup',
    timerDurationSeconds: null,
    servings: String(recipe.servings),
    date: todayKey(),
    mealType: 'dinner',
    createMealLog: true,
    planItemId,
    adjustments: '',
    resultNote: '',
    rating: '',
  };
}

export function sanitizeCookSession(
  value: unknown,
  recipe: Pick<Recipe, 'servings' | 'steps'>,
  planItemId: string | null = null
): RecipeCookSessionState {
  const fallback = buildDefaultCookSession(recipe, planItemId);
  if (!value || typeof value !== 'object') return fallback;
  const parsed = value as Partial<RecipeCookSessionState>;
  return {
    currentStepIndex: clampStepIndex(Number(parsed.currentStepIndex) || 0, Math.max(recipe.steps.length, 1)),
    checkedIngredientIds: Array.isArray(parsed.checkedIngredientIds) ? parsed.checkedIngredientIds.filter((item): item is string => typeof item === 'string') : [],
    completedStepIds: Array.isArray(parsed.completedStepIds) ? parsed.completedStepIds.filter((item): item is string => typeof item === 'string') : [],
    timerSeconds: Math.max(0, Number(parsed.timerSeconds) || 0),
    timerRunning: Boolean(parsed.timerRunning),
    timerMode: parsed.timerMode === 'countdown' ? 'countdown' : 'countup',
    timerDurationSeconds: Number(parsed.timerDurationSeconds) > 0 ? Number(parsed.timerDurationSeconds) : null,
    servings: typeof parsed.servings === 'string' && parsed.servings.trim() ? parsed.servings : fallback.servings,
    date: typeof parsed.date === 'string' && parsed.date ? parsed.date : fallback.date,
    mealType: MEAL_TYPE_OPTIONS.some((item) => item.value === parsed.mealType) ? parsed.mealType as MealType : fallback.mealType,
    createMealLog: typeof parsed.createMealLog === 'boolean' ? parsed.createMealLog : fallback.createMealLog,
    planItemId: typeof parsed.planItemId === 'string' ? parsed.planItemId : planItemId,
    adjustments: typeof parsed.adjustments === 'string' ? parsed.adjustments : '',
    resultNote: typeof parsed.resultNote === 'string' ? parsed.resultNote : '',
    rating: typeof parsed.rating === 'string' ? parsed.rating : '',
  };
}

function loadCookSession(recipe: Pick<Recipe, 'id' | 'servings' | 'steps'>, planItemId: string | null = null) {
  try {
    const raw = window.localStorage.getItem(recipeCookSessionKey(recipe.id));
    if (!raw) return { session: buildDefaultCookSession(recipe, planItemId), restored: false };
    return { session: sanitizeCookSession(JSON.parse(raw), recipe, planItemId), restored: true };
  } catch {
    return { session: buildDefaultCookSession(recipe, planItemId), restored: false };
  }
}

function saveCookSession(recipeId: string, session: RecipeCookSessionState) {
  window.localStorage.setItem(recipeCookSessionKey(recipeId), JSON.stringify({ ...session, timerRunning: false }));
}

function clearCookSession(recipeId: string) {
  window.localStorage.removeItem(recipeCookSessionKey(recipeId));
}

export function buildCookPayload(args: {
  servings: string;
  date: string;
  mealType: MealType;
  createMealLog: boolean;
  planItemId: string | null;
  resultNote: string;
  adjustments: string;
  rating: string;
}): CookRecipeRequest {
  return {
    servings: Number(args.servings),
    date: args.date,
    meal_type: args.mealType,
    create_meal_log: args.createMealLog,
    recipe_plan_item_id: args.planItemId ?? undefined,
    result_note: args.resultNote.trim(),
    adjustments: args.adjustments.trim(),
    rating: args.rating ? Number(args.rating) : null,
  };
}

export function buildRecipeShortageShoppingPayloads(card: Pick<RecipeCardViewModel, 'recipe' | 'shortages'>) {
  return buildShoppingPayloadsFromDrafts(buildShoppingDraftsFromShortages(card));
}

export function getRecipeShoppingRequirement(item: Pick<RecipeIngredient, 'note'>): RecipeShoppingRequirement {
  return /可选|选用|装饰|替代|没有可不放/.test(item.note.trim()) ? 'optional' : 'required';
}

function stripRecipeIngredientRequirementNote(note: string) {
  return note.trim().replace(OPTIONAL_INGREDIENT_NOTE_PATTERN, '').trim();
}

function applyRecipeIngredientRequirement(note: string, requirement: RecipeShoppingRequirement) {
  const normalized = stripRecipeIngredientRequirementNote(note);
  return requirement === 'optional' ? `可选${normalized ? `：${normalized}` : ''}` : normalized;
}

export function buildShoppingDraftsFromShortages(card: Pick<RecipeCardViewModel, 'recipe' | 'shortages'>): RecipeShoppingDraftItem[] {
  return card.shortages.map((item) => {
    const recipeIngredient = card.recipe.ingredient_items.find((entry) => entry.id === item.ingredientId || entry.ingredient_id === item.ingredientId);
    return {
      id: `shortage-${item.ingredientId || item.ingredientName}`,
      title: item.ingredientName,
      quantity: formatShoppingQuantity(Math.max(item.missingQuantity, 1)),
      unit: item.unit,
      reason: `来自菜谱：${card.recipe.title}`,
      source: 'shortage',
      requirement: recipeIngredient ? getRecipeShoppingRequirement(recipeIngredient) : 'required',
      recipeIngredientId: recipeIngredient?.id,
    };
  });
}

export function buildShoppingDraftFromRecipeIngredient(recipeTitle: string, item: RecipeIngredient): RecipeShoppingDraftItem {
  return {
    id: `existing-${item.id}`,
    title: item.ingredient_name,
    quantity: formatShoppingQuantity(Math.max(item.quantity, 1)),
    unit: item.unit || '个',
    reason: `来自菜谱：${recipeTitle}`,
    source: 'existing',
    requirement: getRecipeShoppingRequirement(item),
    recipeIngredientId: item.id,
  };
}

export function buildCustomShoppingDraft(recipeTitle: string, item: RecipeShoppingCustomForm): RecipeShoppingDraftItem | null {
  const title = item.title.trim();
  const quantity = Number(item.quantity);
  if (!title || !Number.isFinite(quantity) || quantity <= 0) return null;
  return {
    id: `custom-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    title,
    quantity: formatShoppingQuantity(quantity),
    unit: item.unit.trim() || '个',
    reason: `来自菜谱：${recipeTitle}`,
    source: 'custom',
    requirement: 'required',
  };
}

export function buildShoppingPayloadsFromDrafts(drafts: RecipeShoppingDraftItem[]) {
  return drafts
    .map((item) => ({
      title: item.title.trim(),
      quantity: Number(item.quantity),
      unit: item.unit.trim() || '个',
      reason: item.reason.trim(),
    }))
    .filter((item) => item.title && Number.isFinite(item.quantity) && item.quantity > 0);
}

function buildShoppingCandidateKey(item: RecipeIngredient) {
  return item.id;
}

function buildRecipeIngredientAvailabilityMap(card: RecipeCardViewModel) {
  return new Map(card.ingredientAvailability.map((item) => [item.item.id, item]));
}

function buildShoppingDraftSourceLabel(source: RecipeShoppingDraftSource) {
  return source === 'shortage' ? '缺料' : source === 'existing' ? '已有食材' : '自定义';
}

function buildShoppingRequirementLabel(requirement: RecipeShoppingRequirement) {
  return requirement === 'optional' ? '可选' : '必须';
}

function isAiRecipeDraft(value: unknown): value is AiRecipeDraft {
  if (!value || typeof value !== 'object') return false;
  const draft = value as Partial<AiRecipeDraft>;
  return typeof draft.title === 'string' && Array.isArray(draft.ingredient_items) && Array.isArray(draft.steps);
}

function mapRecipeIdsToCards(recipeIds: string[] | undefined, cardByRecipeId: Map<string, RecipeCardViewModel>) {
  return (recipeIds ?? [])
    .map((recipeId) => cardByRecipeId.get(recipeId))
    .filter((card): card is RecipeCardViewModel => Boolean(card));
}

function buildRecipeImagePayload(form: RecipeFormState, rows: RecipeDraftIngredient[], ingredients: Ingredient[]): AiRenderPayload {
  const sceneTags = splitTags(form.sceneTags);
  return {
    entity_type: 'recipe',
    title: form.title.trim() || '家庭菜谱',
    size: '1792*1008',
    notes: [
      form.tips.trim(),
      '这张图专门用于做菜页面顶部横向 banner，生成 16:9 宽幅主图，界面会裁切成约 6:1 的长横幅。',
      '画面左侧 55% 保持奶油白或浅暖色干净留白，不放主体、不放文字、不放餐具高光，方便叠放返回、标题和菜谱信息。',
      '成菜或关键食材集中在右侧 35%，靠近右下区域，边缘轻微虚化，整体接近参考图那种浅色、通透、温暖的 banner 背景。',
      '画面必须呈现这份菜谱做完后的成菜状态，保持家庭厨房静物摄影风格，避免卡片封面式居中构图。',
    ]
      .filter(Boolean)
      .join('\n'),
    tags: sceneTags,
    scene: sceneTags.join(' / ') || '家庭日常',
    ingredient_names: rows
      .map((item) => {
        const matched = ingredients.find((ingredient) => ingredient.id === item.ingredient_id);
        return matched?.name ?? item.ingredient_name.trim();
      })
      .filter(Boolean),
  };
}

function buildSceneImagePayload(scene: Pick<ManagedRecipeScene, 'name' | 'description' | 'imagePrompt'>): AiRenderPayload {
  const title = scene.name.trim() || '家庭菜谱场景';
  const prompt = scene.imagePrompt.trim();
  const description = scene.description.trim();
  return {
    entity_type: 'recipe_scene',
    title,
    category: '菜谱场景',
    scene: title,
    tags: [title, ...splitTags(description)].filter(Boolean),
    notes: [
      prompt ? `用户画面描述：${prompt}` : '',
      description ? `场景说明：${description}` : '',
      '这是菜谱场景入口封面，重点表达场景气质和食材方向，不生成海报文字，不生成品牌包装。',
      '画面要和其他 Culina 菜谱、食材、餐食图片保持同一套半写实家庭厨房静物摄影风格。',
    ]
      .filter(Boolean)
      .join('\n'),
  };
}

function RecipeCover(props: { card: RecipeCardViewModel; className?: string }) {
  const url = resolveAssetUrl(props.card.coverUrl);
  return (
    <div className={props.className ? `recipe-work-cover ${props.className}` : 'recipe-work-cover'}>
      {url ? (
        <img src={url} alt={props.card.recipe.title} />
      ) : (
        <RecipeDishIllustration title={props.card.recipe.title} tone={getRecipeVisualTone(props.card.recipe.id)} />
      )}
    </div>
  );
}

function RecipeCard(props: {
  card: RecipeCardViewModel;
  onDetail: () => void;
  onEdit: () => void;
  onCook: () => void;
  onShopping: () => void;
}) {
  return (
    <article className={`recipe-work-card tone-${props.card.availability}`}>
      <RecipeCover card={props.card} />
      <div className="recipe-work-card-body">
        <div className="recipe-work-card-head">
          <div>
            <h3>{props.card.recipe.title}</h3>
            <p>
              {props.card.recipe.prep_minutes} 分钟 · {props.card.recipe.servings} 人份 · {DIFFICULTY_LABELS[props.card.recipe.difficulty]}
            </p>
          </div>
          <Badge className={`recipe-availability-badge tone-${props.card.availability}`}>{props.card.availabilityLabel}</Badge>
        </div>
        <div className="recipe-tag-row">
          {(props.card.recipe.scene_tags.length > 0 ? props.card.recipe.scene_tags : ['家庭日常']).slice(0, 4).map((tag) => (
            <span key={tag} className="chip recipe-chip">
              {tag}
            </span>
          ))}
        </div>
        <p className="recipe-work-ingredient-line">
          {props.card.ingredientPreview.join('、')}
          {props.card.hiddenIngredientCount > 0 ? `、+${props.card.hiddenIngredientCount}` : ''}
        </p>
        <p className="subtle">{props.card.availabilityDetail}</p>
        <div className="recipe-card-actions">
          <ActionButton tone="primary" size="compact" type="button" onClick={props.onCook}>
            开始做
          </ActionButton>
          <ActionButton tone="secondary" size="compact" type="button" onClick={props.onDetail}>
            查看
          </ActionButton>
          <ActionButton tone="secondary" size="compact" type="button" onClick={props.onShopping}>
            加采购
          </ActionButton>
          <ActionButton tone="tertiary" size="compact" type="button" onClick={props.onEdit}>
            编辑
          </ActionButton>
        </div>
      </div>
    </article>
  );
}

function DiscoveryRecipeCard(props: {
  card: RecipeCardViewModel;
  isFavorite: boolean;
  onDetail: () => void;
  onFavorite: () => void;
  onCook: () => void;
  onPlan: () => void;
  isFavoritePending?: boolean;
}) {
  const tags = props.card.recipe.scene_tags.length > 0 ? props.card.recipe.scene_tags : ['家庭日常'];
  const visibleTags = tags.slice(0, 2);
  const hiddenTagCount = Math.max(tags.length - visibleTags.length, 0);
  const canCook = props.card.availability === 'ready';
  return (
    <article className="recipe-discovery-card" onClick={props.onDetail}>
      <RecipeCover card={props.card} className="recipe-discovery-card-cover" />
      <button
        className={props.isFavorite ? 'recipe-favorite-button active' : 'recipe-favorite-button'}
        type="button"
        aria-label={props.isFavorite ? '取消收藏' : '收藏菜谱'}
        disabled={props.isFavoritePending}
        onClick={(event) => {
          event.stopPropagation();
          props.onFavorite();
        }}
      >
        <RecipeUiIcon name="heart" />
      </button>
      <div className="recipe-discovery-card-body">
        <h3 title={props.card.recipe.title}>{props.card.recipe.title}</h3>
        <div className="recipe-discovery-tags">
          {visibleTags.map((tag) => (
            <span key={tag} className="recipe-discovery-pill" title={tag}>
              {tag}
            </span>
          ))}
          {hiddenTagCount > 0 && <span className="recipe-discovery-pill more">+{hiddenTagCount}</span>}
        </div>
        <div className="recipe-discovery-meta">
          <span><RecipeUiIcon name="clock" />{props.card.recipe.prep_minutes} 分钟</span>
          <i aria-hidden="true">·</i>
          <span><RecipeUiIcon name="signal" />{DIFFICULTY_LABELS[props.card.recipe.difficulty]}</span>
        </div>
        <div className={`recipe-discovery-availability tone-${props.card.availability}`}>
          <span>{canCook ? <RecipeUiIcon name="sparkle" /> : <RecipeUiIcon name="filter" />}</span>
          {canCook ? '现在可做' : props.card.shortages.length > 0 ? `缺 ${props.card.shortages.length} 项` : props.card.availabilityLabel}
        </div>
        <div className="recipe-discovery-card-actions">
          <button
            className="recipe-discovery-card-hit"
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              props.onCook();
            }}
          >
            <RecipeUiIcon name="utensils" />
            开始做
          </button>
          <button
            className="recipe-discovery-view-hit"
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              props.onDetail();
            }}
          >
            <RecipeUiIcon name="view" />
            查看
          </button>
        </div>
      </div>
    </article>
  );
}

function RecipeMiniThumb(props: { card: RecipeCardViewModel; onClick?: () => void }) {
  return (
    <button className="recipe-mini-thumb" type="button" onClick={props.onClick}>
      <RecipeCover card={props.card} />
    </button>
  );
}

function RecipeMiniPlaceholder() {
  return <span className="recipe-mini-thumb recipe-mini-thumb-placeholder" />;
}

function RecipeTopItem(props: { card: RecipeCardViewModel; rank: number; count: number; onClick: () => void }) {
  return (
    <button className="recipe-top-item" type="button" onClick={props.onClick}>
      <span className={`recipe-top-rank rank-${props.rank}`}>{props.rank}</span>
      <span>
        <strong>{props.card.recipe.title}</strong>
        <small>本周做了 {props.count} 次</small>
      </span>
    </button>
  );
}

function RecipeTopPlaceholder(props: { rank: number }) {
  return (
    <span className="recipe-top-item recipe-top-placeholder">
      <span className={`recipe-top-rank rank-${props.rank}`}>{props.rank}</span>
      <span>
        <strong>待积累</strong>
        <small>记录后自动统计</small>
      </span>
    </span>
  );
}

function RecipeSideIcon(props: { name: RecipeUiIconName }) {
  return (
    <span className="recipe-side-icon">
      <RecipeUiIcon name={props.name} />
    </span>
  );
}

export function RecipeWorkspace(props: RecipeWorkspaceProps) {
  const categoryScrollRef = useRef<HTMLDivElement | null>(null);
  const discoveryScrollRef = useRef<HTMLDivElement | null>(null);
  const cookTimerMinuteWheelRef = useRef<HTMLDivElement | null>(null);
  const cookTimerSecondWheelRef = useRef<HTMLDivElement | null>(null);
  const discoverySectionRef = useRef<HTMLElement | null>(null);
  const planSectionRef = useRef<HTMLElement | null>(null);
  const recipeNoticeTimerRef = useRef<number | null>(null);
  const previewCookRecipeRef = useRef(props.previewCookRecipe);
  const [categoryScrollState, setCategoryScrollState] = useState({ canLeft: false, canRight: false });
  const [discoveryScrollState, setDiscoveryScrollState] = useState({ canLeft: false, canRight: false });
  const [view, setView] = useState<RecipeWorkspaceView>('library');
  const [selectedRecipeId, setSelectedRecipeId] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [quickFilter, setQuickFilter] = useState<RecipeQuickFilter>('recommend');
  const [sceneFilter, setSceneFilter] = useState('all');
  const [difficultyFilter, setDifficultyFilter] = useState<'all' | Difficulty>('all');
  const [sortMode, setSortMode] = useState<RecipeSortMode>('updated');
  const [recommendationPage, setRecommendationPage] = useState(0);
  const [form, setForm] = useState<RecipeFormState>(() => defaultRecipeForm());
  const [ingredientRows, setIngredientRows] = useState<RecipeDraftIngredient[]>(() => defaultIngredientRows());
  const [planForm, setPlanForm] = useState<{ recipeId: string; planDate: string; mealType: MealType; note: string }>(() => {
    return { recipeId: '', planDate: todayKey(), mealType: 'dinner', note: '' };
  });
  const [planDialogCard, setPlanDialogCard] = useState<RecipeCardViewModel | null>(null);
  const [isPlanDialogOpen, setIsPlanDialogOpen] = useState(false);
  const [planRecipeSearch, setPlanRecipeSearch] = useState('');
  const [isPlanRecipePickerOpen, setIsPlanRecipePickerOpen] = useState(false);
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
  const [shoppingDialogCard, setShoppingDialogCard] = useState<RecipeCardViewModel | null>(null);
  const [shoppingDrafts, setShoppingDrafts] = useState<RecipeShoppingDraftItem[]>([]);
  const [shoppingCustomForm, setShoppingCustomForm] = useState<RecipeShoppingCustomForm>(() => ({ title: '', quantity: '1', unit: '个' }));
  const [isShoppingIngredientPickerOpen, setIsShoppingIngredientPickerOpen] = useState(false);
  const [recipeNotice, setRecipeNotice] = useState<RecipeNotice | null>(null);
  const [recipeDraftAiForm, setRecipeDraftAiForm] = useState<RecipeDraftAiFormState>(() => ({ prompt: '', ingredientIds: [] }));
  const [sceneTagDraft, setSceneTagDraft] = useState('');
  const [visibleStepTips, setVisibleStepTips] = useState<Record<string, boolean>>({});
  const [stepKeyPointSlots, setStepKeyPointSlots] = useState<Record<string, number>>({});
  const [isRecipeDraftGenerating, setIsRecipeDraftGenerating] = useState(false);
  const [recipeDraftError, setRecipeDraftError] = useState<string | null>(null);
  const [isSceneManagerOpen, setIsSceneManagerOpen] = useState(false);
  const [sceneFormMode, setSceneFormMode] = useState<RecipeSceneFormMode>(null);
  const [editingSceneName, setEditingSceneName] = useState<string | null>(null);
  const [sceneDraft, setSceneDraft] = useState<ManagedRecipeScene>(() => defaultSceneDraft());
  const [recipeImageState, setRecipeImageState] = useState<ImageGenerationUiState>(IDLE_IMAGE_GENERATION_STATE);
  const [sceneImageState, setSceneImageState] = useState<ImageGenerationUiState>(IDLE_IMAGE_GENERATION_STATE);
  const [generatingSceneName, setGeneratingSceneName] = useState<string | null>(null);

  const cards = useMemo(
    () => buildRecipeCards(props.recipes, props.ingredients, props.inventoryItems, props.mealLogs, props.foods),
    [props.recipes, props.ingredients, props.inventoryItems, props.mealLogs, props.foods]
  );
  const recipeDraftIngredientOptions = useMemo(() => {
    const today = todayKey();
    const availableIngredientIds = new Set(
      props.inventoryItems
        .filter((item) => item.quantity - (item.consumed_quantity ?? 0) > 0 && (!item.expiry_date || item.expiry_date >= today))
        .map((item) => item.ingredient_id)
    );
    return [...props.ingredients].sort((left, right) => {
      const leftAvailable = availableIngredientIds.has(left.id);
      const rightAvailable = availableIngredientIds.has(right.id);
      if (leftAvailable !== rightAvailable) return leftAvailable ? -1 : 1;
      return left.name.localeCompare(right.name, 'zh-CN');
    });
  }, [props.ingredients, props.inventoryItems]);
  const homeViewModel = useMemo(
    () => buildRecipeHomeViewModel(cards, props.recipeFavorites, props.recipePlanItems, props.mealLogs, props.foods),
    [cards, props.recipeFavorites, props.recipePlanItems, props.mealLogs, props.foods]
  );
  const cardByRecipeId = useMemo(() => new Map(cards.map((card) => [card.recipe.id, card])), [cards]);
  const serverRecommendedCards = useMemo(
    () => mapRecipeIdsToCards(props.recipeDiscovery?.recommended.recipe_ids, cardByRecipeId),
    [props.recipeDiscovery, cardByRecipeId]
  );
  const serverQuickCards = useMemo(
    () => mapRecipeIdsToCards(props.recipeDiscovery?.quick.recipe_ids, cardByRecipeId),
    [props.recipeDiscovery, cardByRecipeId]
  );
  const serverReadyCards = useMemo(
    () => mapRecipeIdsToCards(props.recipeDiscovery?.ready.recipe_ids, cardByRecipeId),
    [props.recipeDiscovery, cardByRecipeId]
  );
  const serverMissingCards = useMemo(
    () => mapRecipeIdsToCards(props.recipeDiscovery?.missing.recipe_ids, cardByRecipeId),
    [props.recipeDiscovery, cardByRecipeId]
  );
  const serverRecentCards = useMemo(
    () => mapRecipeIdsToCards(props.recipeStats?.recently_cooked.map((item) => item.recipe_id), cardByRecipeId),
    [props.recipeStats, cardByRecipeId]
  );
  const serverTopItems = useMemo(
    () =>
      (props.recipeStats?.frequent ?? [])
        .map((item) => {
          const card = cardByRecipeId.get(item.recipe_id);
          return card ? { card, count: item.count } : null;
        })
        .filter((item): item is { card: RecipeCardViewModel; count: number } => Boolean(item)),
    [props.recipeStats, cardByRecipeId]
  );
  const sceneFilters = useMemo(() => getRecipeSceneFilters(cards), [cards]);
  const managedScenes = useMemo(() => props.recipeScenes.map(mapRecipeScene), [props.recipeScenes]);
  const managedSceneMap = new Map(managedScenes.map((scene) => [scene.name, scene]));
  const categoryCards: RecipeSceneCard[] = [
    ...new Map(
      [
        ...homeViewModel.popularCategories.filter((category) => !DUPLICATED_TYPE_LABELS.has(category.name)),
        ...FALLBACK_SCENES.map((name) => ({
          name,
          count: cards.filter((card) => card.recipe.scene_tags.includes(name)).length,
        })),
        ...managedScenes
          .filter((scene) => !scene.hidden && !DUPLICATED_TYPE_LABELS.has(scene.name))
          .map((scene) => ({
            name: scene.name,
            count: cards.filter((card) => card.recipe.scene_tags.includes(scene.name)).length,
            description: scene.description,
            imagePrompt: scene.imagePrompt,
            imageAssetId: scene.imageAssetId,
            imageAssetUrl: scene.imageAssetUrl,
            custom: scene.custom,
          })),
      ].map((category) => [category.name, category])
    ).values(),
  ].filter((category) => !managedSceneMap.get(category.name)?.hidden).slice(0, 10);
  const sceneSelectOptions = [...new Set([...sceneFilters, ...categoryCards.map((category) => category.name)])].sort((left, right) =>
    left.localeCompare(right, 'zh-CN')
  );
  const discoveryBaseCards = useMemo(() => {
    if (quickFilter === 'ready' && serverReadyCards.length > 0) return serverReadyCards;
    if (quickFilter === 'missing' && serverMissingCards.length > 0) return serverMissingCards;
    if (quickFilter === 'quick' && serverQuickCards.length > 0) return serverQuickCards;
    if (quickFilter === 'recommend' && serverRecommendedCards.length > 0) return serverRecommendedCards;
    return homeViewModel.recommendedCards;
  }, [quickFilter, serverReadyCards, serverMissingCards, serverQuickCards, serverRecommendedCards, homeViewModel.recommendedCards]);
  const visibleCards = useMemo(
    () =>
      filterRecipeCards(discoveryBaseCards, {
        search,
        quickFilter,
        sceneFilter,
        difficultyFilter,
        sortMode: quickFilter === 'recommend' ? 'recommend' : sortMode,
        favoriteRecipeIds: homeViewModel.favoriteRecipeIds,
      }),
    [discoveryBaseCards, search, quickFilter, sceneFilter, difficultyFilter, sortMode, homeViewModel.favoriteRecipeIds]
  );
  const cookableCards = useMemo(
    () => filterRecipeCards(serverReadyCards.length > 0 ? serverReadyCards : cards, { search, quickFilter: 'ready', sceneFilter, difficultyFilter, sortMode: 'availability' }),
    [serverReadyCards, cards, search, sceneFilter, difficultyFilter]
  );
  const recommendedWindow = useMemo(() => {
    if (visibleCards.length === 0) return [];
    const windowSize = 3;
    if (visibleCards.length <= windowSize) return visibleCards;
    const start = (recommendationPage * windowSize) % visibleCards.length;
    return [...visibleCards.slice(start, start + windowSize), ...visibleCards.slice(0, Math.max(start + windowSize - visibleCards.length, 0))];
  }, [visibleCards, recommendationPage]);
  const shouldPageRecommendations = quickFilter === 'recommend' && sceneFilter === 'all';
  const displayCards = shouldPageRecommendations ? recommendedWindow : visibleCards;
  const shouldScrollDiscoveryCards = false;
  const recentPreviewCards =
    serverRecentCards.length > 0
      ? serverRecentCards
      : homeViewModel.recentlyCooked.length > 0
        ? homeViewModel.recentlyCooked
        : homeViewModel.recommendedCards.slice(0, 4);
  const quickPreviewCards =
    serverQuickCards.length > 0
      ? serverQuickCards.slice(0, 5)
      : homeViewModel.quickRecipes.length > 0
        ? homeViewModel.quickRecipes.slice(0, 5)
        : homeViewModel.recommendedCards.slice(0, 5);
  const topPreviewItems =
    serverTopItems.length > 0
      ? serverTopItems.slice(0, 3)
      : homeViewModel.weeklyTop.length > 0
      ? homeViewModel.weeklyTop
      : homeViewModel.recommendedCards.slice(0, 3).map((card, index) => ({ card, count: Math.max(2 - index, 1) }));
  const planDays = Array.from({ length: 7 }, (_, index) => {
    const date = addDateKeyDays(props.recipePlanWeekRange.start, index);
    const fallbackDay = homeViewModel.planDays[index];
    return {
      date,
      label: fallbackDay?.label ?? formatDate(date).slice(0, 2),
      items: props.recipePlanItems.filter((item) => item.plan_date === date),
    };
  });
  const plannedDayCount = planDays.filter((day) => day.items.length > 0).length;
  const recentPreviewSlots = Array.from({ length: 4 }, (_, index) => recentPreviewCards[index] ?? null);
  const quickPreviewSlots = Array.from({ length: 5 }, (_, index) => quickPreviewCards[index] ?? null);
  const topPreviewSlots = Array.from({ length: 3 }, (_, index) => topPreviewItems[index] ?? null);
  const recommendationSlots = displayCards;
  const shoppingIngredientOptions = useMemo<RecipeShoppingIngredientOption[]>(
    () =>
      props.ingredients.map((ingredient) => ({
        id: ingredient.id,
        name: ingredient.name,
        unit: ingredient.default_unit || '个',
        imageUrl: resolveIngredientImageUrl(ingredient, ingredient.name),
        category: ingredient.category,
      })),
    [props.ingredients]
  );
  const visibleShoppingIngredientOptions = useMemo(() => {
    const keyword = shoppingCustomForm.title.trim().toLowerCase();
    if (!keyword) return shoppingIngredientOptions.slice(0, 8);
    return shoppingIngredientOptions
      .filter((item) => `${item.name} ${item.category}`.toLowerCase().includes(keyword))
      .slice(0, 8);
  }, [shoppingCustomForm.title, shoppingIngredientOptions]);
  const favoriteSidebarCards =
    homeViewModel.favoriteCards.length > 0 ? homeViewModel.favoriteCards.slice(0, 2) : homeViewModel.recommendedCards.slice(0, 2);
  const visiblePlanDays = planDays;
  const hiddenPlanDayCount = 0;
  const currentWeekRange = getRecipeWeekRange();
  const isCurrentPlanWeek = props.recipePlanWeekRange.start === currentWeekRange.start && props.recipePlanWeekRange.end === currentWeekRange.end;
  const planWeekLabel = isCurrentPlanWeek ? '本周菜单' : '当前周菜单';
  const selectedCard = selectedRecipeId ? cards.find((card) => card.recipe.id === selectedRecipeId) ?? null : null;
  const selectedReadyCount = selectedCard?.ingredientAvailability.filter((item) => item.ready).length ?? 0;
  const selectedIngredientCount = selectedCard?.ingredientAvailability.length ?? 0;
  const selectedShortageCount = selectedCard?.shortages.length ?? 0;
  const selectedRecipePlanItems = selectedCard ? props.recipePlanItems.filter((item) => item.recipe_id === selectedCard.recipe.id) : [];
  const planRecipeQuery = planRecipeSearch.trim().toLowerCase();
  const planRecipeOptions = useMemo(() => {
    if (!planRecipeQuery) return cards;
    return cards.filter((card) => card.searchText.includes(planRecipeQuery) || card.recipe.title.toLowerCase().includes(planRecipeQuery));
  }, [cards, planRecipeQuery]);
  const selectedRecentCookLog =
    selectedCard?.recipe.cook_logs
      .slice()
      .sort((left, right) => right.cook_date.localeCompare(left.cook_date))[0] ?? null;
  const selectedSceneTags = selectedCard
    ? selectedCard.recipe.scene_tags.length > 0
      ? selectedCard.recipe.scene_tags
      : ['家庭日常']
    : [];
  const isSelectedFavorite = selectedCard ? homeViewModel.favoriteRecipeIds.has(selectedCard.recipe.id) : false;
  const editorIngredientCount = ingredientRows.filter((item) => item.ingredient_id || item.ingredient_name.trim()).length;
  const editorStepCount = form.steps.filter((step) => step.text.trim()).length;
  const editorSceneTags = splitTags(form.sceneTags);
  const editorCoverAsset = getImagePreview(form.images);
  const editorCoverUrl = resolveAssetUrl(editorCoverAsset?.url);
  const editorReferenceUrl = resolveAssetUrl(form.images.referenceAsset?.url);
  const editorGeneratedUrl = resolveAssetUrl(form.images.generatedAsset?.url);
  const editorCompletionItems = [
    { label: '已填写基础信息', done: Boolean(form.title.trim() && Number(form.servings) > 0 && Number(form.prepMinutes) > 0) },
    { label: '已添加原料', done: editorIngredientCount > 0 },
    { label: '已添加步骤', done: editorStepCount > 0 },
    { label: '已设置封面', done: Boolean(editorCoverAsset) },
  ];
  const editorCompletionPercent = Math.round(
    (editorCompletionItems.filter((item) => item.done).length / editorCompletionItems.length) * 100
  );
  const activeCookCard = cookCard ?? (view === 'cook' ? selectedCard : null);
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
  const isEditing = view === 'edit' && Boolean(selectedRecipeId);
  const submitDisabled = props.isCreatingRecipe || props.isUpdatingRecipe || recipeImageState.isGenerating;
  const recipeImagePayload = buildRecipeImagePayload(form, ingredientRows, props.ingredients);
  const activeDiscoveryCopy =
    sceneFilter === 'all'
      ? DISCOVERY_SECTION_COPY[quickFilter]
      : {
          title: sceneFilter,
          description:
            quickFilter === 'recommend' || quickFilter === 'all'
              ? '适合这个场景的菜谱'
              : `已叠加“${DISCOVERY_SECTION_COPY[quickFilter].title}”筛选`,
          emptyTitle: `暂无${sceneFilter}菜谱`,
          emptyDescription: '换个场景或清除筛选条件试试。',
        };
  const cookSubmitDisabled =
    props.isCookingRecipe || isCookPreviewLoading || Boolean(cookPreviewError) || Boolean(cookPreview?.shortages.length) || !cookPreview || !cookSession;

  function updateCategoryScrollState() {
    const node = categoryScrollRef.current;
    if (!node) return;
    const canLeft = node.scrollLeft > 2;
    const canRight = node.scrollLeft + node.clientWidth < node.scrollWidth - 2;
    setCategoryScrollState((current) => (current.canLeft === canLeft && current.canRight === canRight ? current : { canLeft, canRight }));
  }

  function updateDiscoveryScrollState() {
    const node = discoveryScrollRef.current;
    if (!node) return;
    const canLeft = node.scrollLeft > 2;
    const canRight = node.scrollLeft + node.clientWidth < node.scrollWidth - 2;
    setDiscoveryScrollState((current) => (current.canLeft === canLeft && current.canRight === canRight ? current : { canLeft, canRight }));
  }

  useEffect(() => {
    updateCategoryScrollState();
  }, [categoryCards.length, sceneFilter, search]);

  useEffect(() => {
    updateDiscoveryScrollState();
  }, [displayCards.length, quickFilter, sceneFilter, search, difficultyFilter, sortMode]);

  useEffect(() => {
    setRecommendationPage(0);
  }, [quickFilter, sceneFilter, search, difficultyFilter, sortMode]);

  useEffect(() => {
    if (!isCookTimerCustomOpen) return;
    window.requestAnimationFrame(() => {
      cookTimerMinuteWheelRef.current?.scrollTo({ top: Math.max(cookTimerPicker.minutes * 38 - 52, 0), behavior: 'auto' });
      cookTimerSecondWheelRef.current?.scrollTo({ top: Math.max(cookTimerPicker.seconds * 38 - 52, 0), behavior: 'auto' });
    });
  }, [isCookTimerCustomOpen, cookTimerPicker.minutes, cookTimerPicker.seconds]);

  useEffect(() => {
    return () => {
      if (recipeNoticeTimerRef.current !== null) {
        window.clearTimeout(recipeNoticeTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    previewCookRecipeRef.current = props.previewCookRecipe;
  }, [props.previewCookRecipe]);

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
    const node = discoveryScrollRef.current;
    if (!node) return;
    node.scrollLeft = 0;
    window.requestAnimationFrame(updateDiscoveryScrollState);
  }, [quickFilter, sceneFilter, search, difficultyFilter, sortMode]);

  useEffect(() => {
    if (view !== 'cook' || !activeCookCard || !cookSession) return;
    saveCookSession(activeCookCard.recipe.id, cookSession);
  }, [view, activeCookCard, cookSession]);

  useEffect(() => {
    if (view !== 'cook' || !cookSession?.timerRunning) return;
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
  }, [view, cookSession?.timerRunning]);

  useEffect(() => {
    if (!cookTimerJustStarted) return;
    const timer = window.setTimeout(() => setCookTimerJustStarted(false), 700);
    return () => window.clearTimeout(timer);
  }, [cookTimerJustStarted]);

  function resetForm() {
    setForm(defaultRecipeForm());
    setIngredientRows(defaultIngredientRows());
    setSceneTagDraft('');
    setVisibleStepTips({});
    setStepKeyPointSlots({});
  }

  function openCreate() {
    resetForm();
    setRecipeDraftAiForm({ prompt: '', ingredientIds: [] });
    setRecipeDraftError(null);
    setRecipeImageState(IDLE_IMAGE_GENERATION_STATE);
    setSelectedRecipeId(null);
    setView('create');
  }

  function openDetail(card: RecipeCardViewModel) {
    setSelectedRecipeId(card.recipe.id);
    setView('detail');
  }

  function openEdit(card: RecipeCardViewModel) {
    const next = buildFormFromRecipe(card.recipe);
    setSelectedRecipeId(card.recipe.id);
    setForm(next.form);
    setIngredientRows(next.ingredients);
    setRecipeImageState(IDLE_IMAGE_GENERATION_STATE);
    setSceneTagDraft('');
    setVisibleStepTips({});
    setStepKeyPointSlots({});
    setView('edit');
  }

  function openCook(card: RecipeCardViewModel, planItemId?: string) {
    const loaded = loadCookSession(card.recipe, planItemId ?? null);
    setSelectedRecipeId(card.recipe.id);
    setCookCard(card);
    setCookSession(loaded.session);
    setWasCookSessionRestored(loaded.restored);
    setIsCookFinishOpen(false);
    setCookPreview(null);
    setCookPreviewError(null);
    setView('cook');
    window.requestAnimationFrame(() => {
      window.scrollTo({ top: 0, left: 0, behavior: 'auto' });
    });
  }

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
    clearCookSession(activeCookCard.recipe.id);
  }

  function exitCookMode(target: 'detail' | 'library' = 'detail') {
    setIsCookFinishOpen(false);
    setCookSession((current) => (current ? { ...current, timerRunning: false } : current));
    setCookCard(null);
    setView(target);
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

  function updateIngredientRow(id: string, key: 'ingredient_id' | 'quantity' | 'unit' | 'note', value: string) {
    setIngredientRows((current) =>
      current.map((item) => {
        if (item.id !== id) return item;
        if (key === 'ingredient_id') {
          const ingredient = props.ingredients.find((entry) => entry.id === value);
          return {
            ...item,
            ingredient_id: value,
            ingredient_name: ingredient?.name ?? '',
            unit: ingredient?.default_unit ?? item.unit,
          };
        }
        return { ...item, [key]: key === 'quantity' ? Number(value) : value };
      })
    );
  }

  function updateIngredientNote(id: string, value: string) {
    setIngredientRows((current) =>
      current.map((item) =>
        item.id === id ? { ...item, note: applyRecipeIngredientRequirement(value, getRecipeShoppingRequirement(item)) } : item
      )
    );
  }

  function updateIngredientRequirement(id: string, requirement: RecipeShoppingRequirement) {
    setIngredientRows((current) =>
      current.map((item) => (item.id === id ? { ...item, note: applyRecipeIngredientRequirement(item.note, requirement) } : item))
    );
  }

  function updateStepDraft(stepId: string, patch: Partial<RecipeStepDraft>) {
    setForm((current) => ({
      ...current,
      steps: current.steps.map((item) => (item.id === stepId ? { ...item, ...patch } : item)),
    }));
  }

  function getStepKeyPointValues(step: RecipeStepDraft) {
    return step.keyPoints ? step.keyPoints.split('\n').slice(0, MAX_STEP_KEY_POINTS) : [];
  }

  function addStepTip(stepId: string) {
    setVisibleStepTips((current) => ({ ...current, [stepId]: true }));
  }

  function getStepKeyPointRowCount(step: RecipeStepDraft) {
    return Math.min(MAX_STEP_KEY_POINTS, Math.max(getStepKeyPointValues(step).length, stepKeyPointSlots[step.id] ?? 0));
  }

  function addStepKeyPoint(step: RecipeStepDraft) {
    const nextCount = Math.min(MAX_STEP_KEY_POINTS, getStepKeyPointRowCount(step) + 1);
    setStepKeyPointSlots((current) => ({ ...current, [step.id]: nextCount }));
  }

  function updateStepKeyPoint(step: RecipeStepDraft, index: number, value: string) {
    const rowCount = Math.max(getStepKeyPointRowCount(step), index + 1);
    const rows = Array.from({ length: Math.min(MAX_STEP_KEY_POINTS, rowCount) }, (_, rowIndex) => getStepKeyPointValues(step)[rowIndex] ?? '');
    rows[index] = value;
    updateStepDraft(step.id, { keyPoints: rows.join('\n') });
    setStepKeyPointSlots((current) => ({ ...current, [step.id]: rows.length }));
  }

  function removeStepKeyPoint(step: RecipeStepDraft, index: number) {
    const rowCount = getStepKeyPointRowCount(step);
    const rows = Array.from({ length: rowCount }, (_, rowIndex) => getStepKeyPointValues(step)[rowIndex] ?? '').filter((_, rowIndex) => rowIndex !== index);
    updateStepDraft(step.id, { keyPoints: rows.join('\n') });
    setStepKeyPointSlots((current) => ({ ...current, [step.id]: rows.length }));
  }

  function addIngredientRow() {
    setIngredientRows((current) => [
      ...current,
      { id: newDraftId('ingredient'), ingredient_name: '', ingredient_id: '', quantity: 1, unit: '个', note: '' },
    ]);
  }

  function removeIngredientRow(id: string) {
    setIngredientRows((current) => (current.length > 1 ? current.filter((item) => item.id !== id) : current));
  }

  function commitSceneTagDraft() {
    const nextTags = splitTags(sceneTagDraft);
    if (nextTags.length === 0) return;
    setForm((current) => ({
      ...current,
      sceneTags: [...new Set([...splitTags(current.sceneTags), ...nextTags])].join('、'),
    }));
    setSceneTagDraft('');
  }

  function updateRecipeDraftIngredientSelection(ingredientId: string, checked: boolean) {
    setRecipeDraftAiForm((current) => ({
      ...current,
      ingredientIds: checked
        ? [...new Set([...current.ingredientIds, ingredientId])]
        : current.ingredientIds.filter((id) => id !== ingredientId),
    }));
  }

  async function generateRecipeDraftFromInventory() {
    if (recipeDraftAiForm.ingredientIds.length === 0) {
      setRecipeDraftError('请选择至少一个食材。');
      return;
    }
    setIsRecipeDraftGenerating(true);
    setRecipeDraftError(null);
    try {
      const response = await props.queryAi({
        mode: 'recipeDraft',
        prompt: recipeDraftAiForm.prompt.trim(),
        ingredient_ids: recipeDraftAiForm.ingredientIds,
      });
      const draft = response.conversation.context.recipeDraft;
      if (!isAiRecipeDraft(draft)) {
        throw new Error('AI 没有返回可填入表单的结构化草稿。');
      }
      setForm((current) => ({
        ...current,
        title: draft.title,
        servings: String(draft.servings || 2),
        prepMinutes: String(draft.prep_minutes || 20),
        difficulty: draft.difficulty || 'easy',
        steps:
          draft.steps.length > 0
            ? draft.steps.map((text) => ({ ...createEmptyRecipeStepDraft(), text }))
            : current.steps,
        tips: draft.tips,
        sceneTags: draft.scene_tags.join('、'),
      }));
      setIngredientRows(
        draft.ingredient_items.length > 0
          ? draft.ingredient_items.map((item) => ({
              id: newDraftId('ingredient'),
              ingredient_id: item.ingredient_id ?? '',
              ingredient_name: item.ingredient_name,
              quantity: item.quantity,
              unit: item.unit,
              note: item.note,
            }))
          : defaultIngredientRows()
      );
    } catch (reason) {
      setRecipeDraftError(resolveErrorMessage(reason, 'AI 菜谱草稿生成失败'));
    } finally {
      setIsRecipeDraftGenerating(false);
    }
  }

  async function submitRecipe(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const payload = buildRecipePayload(form, ingredientRows, props.ingredients);
    if (!payload.title || payload.ingredient_items.length === 0) {
      window.alert('菜谱至少要有标题和一个食材。');
      return;
    }
    try {
      if (isEditing && selectedRecipeId) {
        await props.updateRecipe(selectedRecipeId, payload);
        setView('detail');
      } else {
        const created = await props.createRecipe({ ...payload, auto_create_food: form.autoCreateFood });
        setSelectedRecipeId(created.id);
        resetForm();
        setView('detail');
      }
    } catch (reason) {
      window.alert(resolveErrorMessage(reason, isEditing ? '更新菜谱失败' : '新增菜谱失败'));
    }
  }

  async function deleteSelectedRecipe() {
    if (!selectedCard || !window.confirm(`确定删除「${selectedCard.recipe.title}」吗？`)) return;
    try {
      await props.deleteRecipe(selectedCard.recipe.id);
      setSelectedRecipeId(null);
      setView('library');
    } catch (reason) {
      window.alert(resolveErrorMessage(reason, '删除菜谱失败'));
    }
  }

  function openShoppingDialog(card: RecipeCardViewModel) {
    setCookCard(null);
    setCookPreview(null);
    setCookPreviewError(null);
    setShoppingDialogCard(card);
    setShoppingDrafts(buildShoppingDraftsFromShortages(card));
    setShoppingCustomForm({ title: '', quantity: '1', unit: '个' });
  }

  function closeShoppingDialog() {
    setShoppingDialogCard(null);
    setShoppingDrafts([]);
    setShoppingCustomForm({ title: '', quantity: '1', unit: '个' });
  }

  function updateShoppingDraft(itemId: string, patch: Partial<Pick<RecipeShoppingDraftItem, 'title' | 'quantity' | 'unit' | 'reason'>>) {
    setShoppingDrafts((current) => current.map((item) => (item.id === itemId ? { ...item, ...patch } : item)));
  }

  function showRecipeNotice(notice: RecipeNotice) {
    if (recipeNoticeTimerRef.current !== null) {
      window.clearTimeout(recipeNoticeTimerRef.current);
    }
    setRecipeNotice(notice);
    recipeNoticeTimerRef.current = window.setTimeout(() => {
      setRecipeNotice(null);
      recipeNoticeTimerRef.current = null;
    }, 3200);
  }

  function adjustShoppingDraftQuantity(itemId: string, delta: number) {
    setShoppingDrafts((current) =>
      current.map((item) => {
        if (item.id !== itemId) return item;
        const currentQuantity = Number(item.quantity);
        const nextQuantity = Math.max(0.01, (Number.isFinite(currentQuantity) ? currentQuantity : 1) + delta);
        return { ...item, quantity: formatShoppingQuantity(nextQuantity) };
      })
    );
  }

  function removeShoppingDraft(itemId: string) {
    setShoppingDrafts((current) => current.filter((item) => item.id !== itemId));
  }

  function addRecipeIngredientToShoppingDraft(item: RecipeIngredient) {
    if (!shoppingDialogCard) return;
    const draft = buildShoppingDraftFromRecipeIngredient(shoppingDialogCard.recipe.title, item);
    setShoppingDrafts((current) => {
      if (current.some((entry) => entry.recipeIngredientId === item.id)) return current;
      return [...current, draft];
    });
  }

  function addCustomShoppingDraft() {
    if (!shoppingDialogCard) return;
    const draft = buildCustomShoppingDraft(shoppingDialogCard.recipe.title, shoppingCustomForm);
    if (!draft) {
      showRecipeNotice({ tone: 'warning', title: '还差一点', message: '请填写采购名称和大于 0 的数量。' });
      return;
    }
    setShoppingDrafts((current) => [...current, draft]);
    setShoppingCustomForm({ title: '', quantity: '1', unit: shoppingCustomForm.unit.trim() || '个' });
    setIsShoppingIngredientPickerOpen(false);
  }

  function adjustCustomShoppingQuantity(delta: number) {
    const currentQuantity = Number(shoppingCustomForm.quantity);
    const nextQuantity = Math.max(0.01, (Number.isFinite(currentQuantity) ? currentQuantity : 1) + delta);
    setShoppingCustomForm({ ...shoppingCustomForm, quantity: formatShoppingQuantity(nextQuantity) });
  }

  function selectShoppingIngredientOption(option: RecipeShoppingIngredientOption) {
    setShoppingCustomForm((current) => ({
      ...current,
      title: option.name,
      unit: option.unit,
    }));
    setIsShoppingIngredientPickerOpen(false);
  }

  async function submitShoppingDrafts() {
    const payloads = buildShoppingPayloadsFromDrafts(shoppingDrafts);
    if (payloads.length === 0) {
      showRecipeNotice({ tone: 'warning', title: '没有可加入项', message: '请至少保留一个有效采购项。' });
      return;
    }
    try {
      await Promise.all(payloads.map((payload) => props.createShoppingItem(payload)));
      closeShoppingDialog();
      showRecipeNotice({ tone: 'success', title: '已加入采购清单', message: `${payloads.length} 项食材已放进采购清单。` });
    } catch (reason) {
      showRecipeNotice({ tone: 'danger', title: '加入采购失败', message: resolveErrorMessage(reason, '加入采购失败') });
    }
  }

  async function toggleRecipeFavorite(card: RecipeCardViewModel) {
    try {
      if (homeViewModel.favoriteRecipeIds.has(card.recipe.id)) {
        await props.removeRecipeFavorite(card.recipe.id);
      } else {
        await props.addRecipeFavorite(card.recipe.id);
      }
    } catch (reason) {
      window.alert(resolveErrorMessage(reason, '更新收藏失败'));
    }
  }

  function defaultPlanDateForSelectedWeek() {
    const today = todayKey();
    return today >= props.recipePlanWeekRange.start && today <= props.recipePlanWeekRange.end ? today : props.recipePlanWeekRange.start;
  }

  function openPlanDialog(card?: RecipeCardViewModel) {
    setPlanDialogCard(card ?? null);
    setPlanRecipeSearch('');
    setIsPlanRecipePickerOpen(false);
    setPlanForm({
      recipeId: card?.recipe.id ?? '',
      planDate: defaultPlanDateForSelectedWeek(),
      mealType: 'dinner',
      note: '',
    });
    setIsPlanDialogOpen(true);
  }

  function closePlanDialog() {
    setIsPlanDialogOpen(false);
    setPlanDialogCard(null);
    setPlanRecipeSearch('');
    setIsPlanRecipePickerOpen(false);
  }

  function selectPlanRecipe(card: RecipeCardViewModel) {
    setPlanForm((current) => ({ ...current, recipeId: card.recipe.id }));
    setPlanDialogCard(card);
    setPlanRecipeSearch('');
    setIsPlanRecipePickerOpen(false);
  }

  function buildRecipeScenePayload(scene: ManagedRecipeScene) {
    const existingIndex = managedScenes.findIndex((item) => item.name === scene.name);
    return {
      name: scene.name.trim(),
      description: scene.description.trim(),
      image_prompt: scene.imagePrompt.trim(),
      image_asset_id: scene.imageAssetId,
      hidden: Boolean(scene.hidden),
      custom: scene.custom ?? true,
      sort_order: existingIndex >= 0 ? existingIndex : managedScenes.length,
    };
  }

  function openCreateSceneForm() {
    setSceneFormMode('create');
    setEditingSceneName(null);
    setSceneDraft(defaultSceneDraft());
    setSceneImageState(IDLE_IMAGE_GENERATION_STATE);
  }

  function openEditSceneForm(scene: RecipeSceneCard) {
    setSceneFormMode('edit');
    setEditingSceneName(scene.name);
    setSceneDraft({
      id: managedScenes.find((item) => item.name === scene.name)?.id,
      name: scene.name,
      description: scene.description || '',
      imagePrompt: scene.imagePrompt || `${scene.name} 的家庭厨房场景图`,
      imageAssetId: scene.imageAssetId,
      imageAssetUrl: scene.imageAssetUrl,
      custom: scene.custom ?? true,
    });
    setSceneImageState(IDLE_IMAGE_GENERATION_STATE);
  }

  function closeSceneForm() {
    setSceneFormMode(null);
    setEditingSceneName(null);
    setSceneDraft(defaultSceneDraft());
    setSceneImageState(IDLE_IMAGE_GENERATION_STATE);
  }

  async function submitSceneDraft(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const name = sceneDraft.name.trim();
    if (!name) {
      window.alert('请填写场景名称。');
      return;
    }
    if (DUPLICATED_TYPE_LABELS.has(name)) {
      window.alert('这个名称会和上方筛选重复，请换一个场景名称。');
      return;
    }
    const nextScene = {
      name,
      description: sceneDraft.description.trim(),
      imagePrompt: sceneDraft.imagePrompt.trim(),
      imageAssetId: sceneDraft.imageAssetId,
      imageAssetUrl: sceneDraft.imageAssetUrl,
      custom: true,
    };
    const existing = managedScenes.find((scene) => scene.name === (editingSceneName ?? name));
    try {
      if (existing?.id) {
        await props.updateRecipeScene(existing.id, buildRecipeScenePayload(nextScene));
      } else {
        await props.createRecipeScene(buildRecipeScenePayload(nextScene));
      }
      closeSceneForm();
    } catch (reason) {
      window.alert(resolveErrorMessage(reason, '保存场景失败'));
    }
  }

  async function deleteManagedScene(sceneName: string) {
    const existing = managedScenes.find((scene) => scene.name === sceneName);
    try {
      if (existing?.id && existing.custom) {
        await props.deleteRecipeScene(existing.id);
      } else if (existing?.id) {
        await props.updateRecipeScene(existing.id, { hidden: true });
      } else {
        await props.createRecipeScene({
          name: sceneName,
          description: '',
          image_prompt: '',
          hidden: true,
          custom: false,
          sort_order: managedScenes.length,
        });
      }
      if (sceneFilter === sceneName) {
        setSceneFilter('all');
      }
    } catch (reason) {
      window.alert(resolveErrorMessage(reason, '删除场景失败'));
    }
  }

  async function restoreManagedScene(sceneName: string) {
    const existing = managedScenes.find((scene) => scene.name === sceneName);
    if (!existing?.id) return;
    try {
      if (existing.custom) {
        await props.updateRecipeScene(existing.id, { hidden: false });
      } else {
        await props.deleteRecipeScene(existing.id);
      }
    } catch (reason) {
      window.alert(resolveErrorMessage(reason, '恢复场景失败'));
    }
  }

  async function handleRecipeImageUpload(files: FileList | null) {
    if (!files || files.length === 0) return;
    const [file] = Array.from(files);
    if (!file) return;
    setRecipeImageState({ isGenerating: true, errorMessage: null });
    try {
      const nextImages = await uploadReferenceAndGenerateImage(file, recipeImagePayload);
      setForm((current) => ({ ...current, images: nextImages }));
      setRecipeImageState(IDLE_IMAGE_GENERATION_STATE);
    } catch (reason) {
      const referenceAsset = extractReferenceAsset(reason);
      setForm((current) => ({ ...current, images: referenceAsset ? { referenceAsset } : emptyImages() }));
      setRecipeImageState({
        isGenerating: false,
        errorMessage: referenceAsset
          ? `${resolveErrorMessage(reason, '参考图上传或 AI 主图生成失败')}，参考图已保留，可重试生成主图。`
          : resolveErrorMessage(reason, '参考图上传或 AI 主图生成失败'),
      });
    }
  }

  async function handleRecipeImageGenerate(mode: 'reference' | 'text') {
    setRecipeImageState({ isGenerating: true, errorMessage: null });
    try {
      const nextImages =
        mode === 'reference' && form.images.referenceAsset
          ? await regenerateImageFromReference(form.images.referenceAsset.id, recipeImagePayload)
          : await generateImageFromText(recipeImagePayload);
      setForm((current) => ({
        ...current,
        images: {
          referenceAsset: nextImages.referenceAsset ?? current.images.referenceAsset,
          generatedAsset: nextImages.generatedAsset,
        },
      }));
      setRecipeImageState(IDLE_IMAGE_GENERATION_STATE);
    } catch (reason) {
      setRecipeImageState({ isGenerating: false, errorMessage: resolveErrorMessage(reason, 'AI 主图生成失败') });
    }
  }

  function resetRecipeImageInput() {
    setForm((current) => ({ ...current, images: emptyImages() }));
    setRecipeImageState(IDLE_IMAGE_GENERATION_STATE);
  }

  async function generateSceneImage(scene: ManagedRecipeScene, options: { draft?: boolean } = {}) {
    const name = scene.name.trim();
    if (!name) {
      window.alert('请先填写场景名称。');
      return;
    }
    setGeneratingSceneName(name);
    setSceneImageState({ isGenerating: true, errorMessage: null });
    try {
      const nextImages = await generateImageFromText(buildSceneImagePayload(scene));
      const generatedAsset = nextImages.generatedAsset;
      if (!generatedAsset) {
        throw new Error('AI 主图生成失败');
      }
      const nextScene: ManagedRecipeScene = {
        ...scene,
        name,
        description: scene.description.trim(),
        imagePrompt: scene.imagePrompt.trim(),
        imageAssetId: generatedAsset.id,
        imageAssetUrl: generatedAsset.url,
        custom: scene.custom ?? true,
      };
      if (options.draft) {
        setSceneDraft(nextScene);
      } else if (scene.id) {
        await props.updateRecipeScene(scene.id, {
          image_prompt: nextScene.imagePrompt,
          image_asset_id: generatedAsset.id,
          hidden: false,
        });
      } else {
        await props.createRecipeScene(buildRecipeScenePayload(nextScene));
      }
      setSceneImageState(IDLE_IMAGE_GENERATION_STATE);
    } catch (reason) {
      setSceneImageState({ isGenerating: false, errorMessage: resolveErrorMessage(reason, '场景图片生成失败') });
    } finally {
      setGeneratingSceneName(null);
    }
  }

  async function submitPlanItem(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!planForm.recipeId) {
      window.alert(cards.length === 0 ? '先新增一份菜谱，再安排菜单计划。' : '请选择要加入菜单的菜谱。');
      return;
    }
    try {
      await props.createRecipePlanItem({
        recipe_id: planForm.recipeId,
        plan_date: planForm.planDate,
        meal_type: planForm.mealType,
        note: planForm.note.trim(),
      });
      closePlanDialog();
      setPlanForm((current) => ({ ...current, recipeId: '', planDate: defaultPlanDateForSelectedWeek(), note: '' }));
    } catch (reason) {
      window.alert(resolveErrorMessage(reason, '添加菜单计划失败'));
    }
  }

  async function updatePlanDate(item: RecipePlanItem, planDate: string) {
    try {
      await props.updateRecipePlanItem(item.id, { plan_date: planDate });
    } catch (reason) {
      window.alert(resolveErrorMessage(reason, '更新计划日期失败'));
    }
  }

  async function updatePlanMealType(item: RecipePlanItem, mealType: MealType) {
    try {
      await props.updateRecipePlanItem(item.id, { meal_type: mealType });
    } catch (reason) {
      window.alert(resolveErrorMessage(reason, '更新计划餐次失败'));
    }
  }

  async function deletePlanItem(item: RecipePlanItem) {
    try {
      await props.deleteRecipePlanItem(item.id);
    } catch (reason) {
      window.alert(resolveErrorMessage(reason, '删除菜单计划失败'));
    }
  }

  async function submitCookRecipe(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!activeCookCard || !cookSession) return;
    try {
      const response = await props.cookRecipe(
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
        showRecipeNotice({ tone: 'warning', title: '库存不足', message: response.shortages.map((item) => item.ingredient_name).join('、') });
        return;
      }
      clearCookSession(activeCookCard.recipe.id);
      setSelectedRecipeId(activeCookCard.recipe.id);
      closeCookDialog();
      setView('detail');
      showRecipeNotice({
        tone: 'success',
        title: '烹饪完成',
        message: cookSession.createMealLog ? '已扣减库存并生成餐食记录。' : '已扣减库存。',
      });
    } catch (reason) {
      showRecipeNotice({ tone: 'danger', title: '开始做失败', message: resolveErrorMessage(reason, '开始做失败') });
    }
  }

  function renderFilters() {
    return (
      <section className="recipe-filter-shell">
        <div className="recipe-search-row">
          <label className="recipe-search-input-shell">
            <span className="recipe-search-input-icon" aria-hidden="true">
              <RecipeUiIcon name="search" />
            </span>
            <input
              className="text-input"
              placeholder="搜索菜谱、场景、食材或技巧"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </label>
          <select className="text-input recipe-filter-select" value={sceneFilter} onChange={(event) => setSceneFilter(event.target.value)}>
            <option value="all">全部场景</option>
            {sceneSelectOptions.map((scene) => (
              <option key={scene} value={scene}>
                {scene}
              </option>
            ))}
          </select>
          <select
            className="text-input recipe-filter-select"
            value={difficultyFilter}
            onChange={(event) => setDifficultyFilter(event.target.value as 'all' | Difficulty)}
          >
            <option value="all">全部难度</option>
            <option value="easy">简单</option>
            <option value="medium">中等</option>
            <option value="hard">复杂</option>
          </select>
          <select className="text-input recipe-filter-select" value={sortMode} onChange={(event) => setSortMode(event.target.value as RecipeSortMode)}>
            {SORT_OPTIONS.map((item) => (
              <option key={item.value} value={item.value}>
                {item.label}
              </option>
            ))}
          </select>
          <button className="recipe-filter-action" type="button">
            <RecipeUiIcon name="filter" />
            筛选
          </button>
        </div>
        <div className="recipe-filter-row">
          {QUICK_FILTERS.map((item) => (
            <button
              key={item.value}
              className={quickFilter === item.value ? 'chip recipe-filter-chip active' : 'chip recipe-filter-chip'}
              type="button"
              onClick={() => {
                setQuickFilter(item.value);
                setSceneFilter('all');
                setRecommendationPage(0);
              }}
            >
              {item.label}
            </button>
          ))}
        </div>
      </section>
    );
  }

  function renderCardGrid(items: RecipeCardViewModel[]) {
    return items.length > 0 ? (
      <div className="recipe-work-grid">
        {items.map((card) => (
          <RecipeCard
            key={card.recipe.id}
            card={card}
            onDetail={() => openDetail(card)}
            onEdit={() => openEdit(card)}
            onCook={() => openCook(card)}
            onShopping={() => openShoppingDialog(card)}
          />
        ))}
      </div>
    ) : (
      <EmptyState
        title={props.recipes.length === 0 ? '还没有菜谱' : '没有匹配的菜谱'}
        description={props.recipes.length === 0 ? '先新增几份常做菜，后面就能按库存推荐。' : '换个筛选条件试试。'}
        action={
          <ActionButton tone="primary" type="button" onClick={openCreate}>
            新增菜谱
          </ActionButton>
        }
      />
    );
  }

  function scrollCategories(direction: 'left' | 'right') {
    categoryScrollRef.current?.scrollBy({
      left: direction === 'left' ? -260 : 260,
      behavior: 'smooth',
    });
    window.setTimeout(updateCategoryScrollState, 260);
  }

  function scrollDiscoveryCards(direction: 'left' | 'right') {
    discoveryScrollRef.current?.scrollBy({
      left: direction === 'left' ? -720 : 720,
      behavior: 'smooth',
    });
    window.setTimeout(updateDiscoveryScrollState, 260);
  }

  function showDiscoveryFilter(filter: RecipeQuickFilter, options: { sort?: RecipeSortMode } = {}) {
    setQuickFilter(filter);
    setSceneFilter('all');
    setSearch('');
    setDifficultyFilter('all');
    if (options.sort) {
      setSortMode(options.sort);
    }
    setRecommendationPage(0);
    window.requestAnimationFrame(() => {
      discoverySectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  }

  function showPlanSection() {
    props.onRecipePlanCurrentWeek();
    window.requestAnimationFrame(() => {
      planSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  }

  return (
    <div className={`recipe-workspace${view === 'cook' ? ' recipe-workspace-cook-mode' : ''}`}>
      {recipeNotice && (
        <div className={`recipe-notice-toast tone-${recipeNotice.tone}`} role={recipeNotice.tone === 'danger' ? 'alert' : 'status'} aria-live="polite">
          <span className="recipe-notice-icon">
            <RecipeUiIcon name={recipeNotice.tone === 'success' ? 'check' : 'warning'} />
          </span>
          <span className="recipe-notice-copy">
            <strong>{recipeNotice.title}</strong>
            <small>{recipeNotice.message}</small>
          </span>
          <button type="button" onClick={() => setRecipeNotice(null)} aria-label="关闭提示">
            ×
          </button>
        </div>
      )}
      {view === 'create' || view === 'edit' ? (
        <WorkspaceSubpageShell className="recipe-editor-subpage">
          <div className="recipe-editor-topbar">
            <button className="workspace-back-link recipe-detail-back-link" type="button" onClick={() => setView(isEditing ? 'detail' : 'library')}>
              <RecipeUiIcon name="chevronLeft" />
              {isEditing ? '返回详情' : '返回菜谱'}
            </button>
          </div>
          <div className="recipe-editor-title-block">
            <p className="eyebrow">菜谱</p>
            <h2>{isEditing ? '编辑菜谱' : '新增菜谱'}</h2>
            <p>把标题、用料、步骤和图片放在同一个录入工作台里。</p>
          </div>

          <form className="recipe-editor-workbench" onSubmit={submitRecipe}>
            <main className="recipe-editor-main-column">
              <section className="recipe-editor-card">
                <div className="recipe-editor-card-head">
                  <span className="recipe-editor-section-index">1</span>
                  <h3>基础信息</h3>
                </div>
                <div className="recipe-editor-basic-grid">
                  <label>
                    <span>菜谱标题</span>
                    <input className="text-input" value={form.title} onChange={(event) => setForm({ ...form, title: event.target.value })} />
                  </label>
                  <label>
                    <span>份量</span>
                    <select className="text-input" value={form.servings} onChange={(event) => setForm({ ...form, servings: event.target.value })}>
                      {[1, 2, 3, 4, 5, 6, 8].map((serving) => (
                        <option key={serving} value={String(serving)}>{serving} 人份</option>
                      ))}
                    </select>
                  </label>
                  <label>
                    <span>准备时长（分钟）</span>
                    <input className="text-input" type="number" min="1" value={form.prepMinutes} onChange={(event) => setForm({ ...form, prepMinutes: event.target.value })} />
                  </label>
                  <label>
                    <span>难度</span>
                    <select className="text-input" value={form.difficulty} onChange={(event) => setForm({ ...form, difficulty: event.target.value as Difficulty })}>
                      <option value="easy">简单</option>
                      <option value="medium">中等</option>
                      <option value="hard">复杂</option>
                    </select>
                  </label>
                  <div className="recipe-editor-tag-field">
                    <span>适用场景标签</span>
                    <div className="recipe-editor-tag-box">
                      {editorSceneTags.map((tag) => (
                        <button
                          key={tag}
                          type="button"
                          onClick={() => setForm({ ...form, sceneTags: editorSceneTags.filter((item) => item !== tag).join('、') })}
                        >
                          {tag} ×
                        </button>
                      ))}
                      <input
                        value={sceneTagDraft}
                        placeholder="+ 添加标签"
                        onChange={(event) => setSceneTagDraft(event.target.value)}
                        onBlur={commitSceneTagDraft}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter' || event.key === ',' || event.key === '，' || event.key === '、') {
                            event.preventDefault();
                            commitSceneTagDraft();
                          }
                        }}
                      />
                    </div>
                  </div>
                  <label className="recipe-editor-tips-field">
                    <span>技巧 / 说明（选填）</span>
                    <textarea className="text-input" rows={3} value={form.tips} onChange={(event) => setForm({ ...form, tips: event.target.value })} />
                    <small>{form.tips.length}/200</small>
                  </label>
                </div>
              </section>

              <section className="recipe-editor-card">
                <div className="recipe-editor-card-head">
                  <span className="recipe-editor-section-index">2</span>
                  <h3>原料清单</h3>
                  <ActionButton tone="secondary" size="compact" type="button" onClick={addIngredientRow}>
                    <RecipeUiIcon name="plus" />
                    添加原料
                  </ActionButton>
                </div>
                <div className="recipe-editor-ingredient-table">
                  <div className="recipe-editor-ingredient-head">
                    <span />
                    <span>原料</span>
                    <span>数量</span>
                    <span>单位</span>
                    <span>类型</span>
                    <span>备注（选填）</span>
                    <span>操作</span>
                  </div>
                  {ingredientRows.map((item, index) => (
                    <div key={item.id} className="recipe-editor-ingredient-row">
                      <span className="recipe-editor-drag-handle">::</span>
                      <select className="text-input" value={item.ingredient_id ?? ''} onChange={(event) => updateIngredientRow(item.id, 'ingredient_id', event.target.value)}>
                        <option value="">{item.ingredient_name || `选择原料 ${index + 1}`}</option>
                        {props.ingredients.map((ingredient) => (
                          <option key={ingredient.id} value={ingredient.id}>
                            {ingredient.name}
                          </option>
                        ))}
                      </select>
                      <input className="text-input" type="number" min="0.1" step="0.1" value={item.quantity} onChange={(event) => updateIngredientRow(item.id, 'quantity', event.target.value)} />
                      <select className="text-input" value={item.unit} onChange={(event) => updateIngredientRow(item.id, 'unit', event.target.value)}>
                        {[...new Set([item.unit, ...SHOPPING_UNIT_OPTIONS])].filter(Boolean).map((unit) => (
                          <option key={unit} value={unit}>{unit}</option>
                        ))}
                      </select>
                      <select
                        className="text-input"
                        value={getRecipeShoppingRequirement(item)}
                        onChange={(event) => updateIngredientRequirement(item.id, event.target.value as RecipeShoppingRequirement)}
                      >
                        <option value="required">必须</option>
                        <option value="optional">可选</option>
                      </select>
                      <input
                        className="text-input"
                        value={stripRecipeIngredientRequirementNote(item.note)}
                        placeholder="处理备注"
                        onChange={(event) => updateIngredientNote(item.id, event.target.value)}
                      />
                      <button className="recipe-editor-icon-button" type="button" onClick={() => removeIngredientRow(item.id)} aria-label={`删除原料 ${index + 1}`}>
                        <RecipeUiIcon name="minus" />
                      </button>
                    </div>
                  ))}
                </div>
              </section>

              <section className="recipe-editor-card">
                <div className="recipe-editor-card-head">
                  <span className="recipe-editor-section-index">3</span>
                  <h3>步骤</h3>
                  <ActionButton tone="secondary" size="compact" type="button" onClick={() => setForm({ ...form, steps: [...form.steps, createEmptyRecipeStepDraft()] })}>
                    <RecipeUiIcon name="plus" />
                    添加步骤
                  </ActionButton>
                </div>
                <div className="recipe-editor-step-list">
                  {form.steps.map((step, index) => {
                    const showTip = Boolean(step.tip.trim()) || Boolean(visibleStepTips[step.id]);
                    const keyPointRowCount = getStepKeyPointRowCount(step);
                    const keyPointRows = Array.from({ length: keyPointRowCount }, (_, rowIndex) => getStepKeyPointValues(step)[rowIndex] ?? '');
                    return (
                      <div key={step.id} className="recipe-editor-step-card">
                        <span className="recipe-editor-step-index">{index + 1}</span>
                        <div className="recipe-editor-step-fields">
                          <label>
                            <span>图标</span>
                            <span className="recipe-editor-icon-select">
                              <RecipeUiIcon name={getRecipeStepIconName(step.icon)} />
                              <select
                                className="text-input"
                                value={step.icon}
                                onChange={(event) => updateStepDraft(step.id, { icon: event.target.value })}
                              >
                                {RECIPE_STEP_ICON_OPTIONS.map((option) => (
                                  <option key={option.value} value={option.value}>
                                    {option.label}
                                  </option>
                                ))}
                              </select>
                            </span>
                          </label>
                          <label>
                            <span>预计用时（分钟）</span>
                            <input
                              className="text-input"
                              type="number"
                              min="0"
                              step="1"
                              value={step.estimatedMinutes}
                              onChange={(event) => updateStepDraft(step.id, { estimatedMinutes: event.target.value })}
                            />
                          </label>
                          <label>
                            <span>步骤名称</span>
                            <input
                              className="text-input"
                              value={step.title}
                              placeholder="例如：冷蒸三文鱼"
                              onChange={(event) => updateStepDraft(step.id, { title: event.target.value })}
                            />
                          </label>
                          <label>
                            <span>一句话说明</span>
                            <input
                              className="text-input"
                              value={step.summary}
                              placeholder="例如：蒸出嫩滑口感"
                              onChange={(event) => updateStepDraft(step.id, { summary: event.target.value })}
                            />
                          </label>

                          <section className="recipe-editor-step-detail recipe-editor-step-wide">
                            <span className="recipe-editor-step-detail-icon"><RecipeUiIcon name="clipboard" /></span>
                            <label>
                              <span>详细操作</span>
                              <textarea
                                className="text-input"
                                rows={3}
                                value={step.text}
                                placeholder="写清楚处理、火候和时间。"
                                onChange={(event) => updateStepDraft(step.id, { text: event.target.value })}
                              />
                            </label>
                          </section>

                          <section className="recipe-editor-step-detail recipe-editor-step-wide">
                            <span className="recipe-editor-step-detail-icon"><RecipeUiIcon name="sparkle" /></span>
                            <div className="recipe-editor-step-extra-head">
                              <div>
                                <strong>烹饪小贴士（选填）</strong>
                                <small>仅可添加 1 条</small>
                              </div>
                              {!showTip && (
                                <button type="button" onClick={() => addStepTip(step.id)}>
                                  <RecipeUiIcon name="plus" />
                                  添加小贴士
                                </button>
                              )}
                            </div>
                            {showTip && (
                              <textarea
                                className="text-input"
                                rows={2}
                                value={step.tip}
                                placeholder="例如：出锅前补一小勺热油，香气更明显。"
                                onChange={(event) => updateStepDraft(step.id, { tip: event.target.value })}
                              />
                            )}
                          </section>

                          <section className="recipe-editor-step-detail recipe-editor-step-wide">
                            <span className="recipe-editor-step-detail-icon"><RecipeUiIcon name="star" /></span>
                            <div className="recipe-editor-step-extra-head">
                              <div>
                                <strong>关键要点（选填）</strong>
                                <small>最多 3 条，每条一句</small>
                              </div>
                              {keyPointRowCount < MAX_STEP_KEY_POINTS && (
                                <button type="button" onClick={() => addStepKeyPoint(step)}>
                                  <RecipeUiIcon name="plus" />
                                  添加要点
                                </button>
                              )}
                            </div>
                            <div className="recipe-editor-keypoint-list">
                              {keyPointRows.map((point, pointIndex) => (
                                <div key={`${step.id}-keypoint-${pointIndex}`} className="recipe-editor-keypoint-row">
                                  <span className="recipe-editor-drag-handle">::</span>
                                  <input
                                    className="text-input"
                                    value={point}
                                    placeholder={`要点 ${pointIndex + 1}`}
                                    onChange={(event) => updateStepKeyPoint(step, pointIndex, event.target.value)}
                                  />
                                  <button type="button" onClick={() => removeStepKeyPoint(step, pointIndex)} aria-label={`删除要点 ${pointIndex + 1}`}>
                                    <RecipeUiIcon name="minus" />
                                  </button>
                                </div>
                              ))}
                              {keyPointRowCount === 0 && (
                                <button className="recipe-editor-keypoint-placeholder" type="button" onClick={() => addStepKeyPoint(step)}>
                                  还可添加 3 条（最多 3 条）
                                </button>
                              )}
                              {keyPointRowCount > 0 && keyPointRowCount < MAX_STEP_KEY_POINTS && (
                                <button className="recipe-editor-keypoint-placeholder" type="button" onClick={() => addStepKeyPoint(step)}>
                                  还可添加 {MAX_STEP_KEY_POINTS - keyPointRowCount} 条（最多 3 条）
                                </button>
                              )}
                            </div>
                          </section>
                        </div>
                        <button
                          className="recipe-editor-icon-button"
                          type="button"
                          onClick={() => setForm({ ...form, steps: form.steps.length > 1 ? form.steps.filter((item) => item.id !== step.id) : form.steps })}
                          aria-label={`删除步骤 ${index + 1}`}
                        >
                          <RecipeUiIcon name="minus" />
                        </button>
                      </div>
                    );
                  })}
                </div>
              </section>

              <section className="recipe-editor-card recipe-editor-cover-card">
                <div className="recipe-editor-card-head">
                  <span className="recipe-editor-section-index">4</span>
                  <h3>菜谱封面</h3>
                </div>
                <div className="recipe-editor-cover-grid">
                  <div className="recipe-editor-cover-preview">
                    {editorCoverUrl ? (
                      <img src={editorCoverUrl} alt={form.title || '菜谱封面'} />
                    ) : (
                      <RecipeDishIllustration title={form.title || '菜谱封面'} tone={getRecipeVisualTone(selectedRecipeId ?? (form.title || 'draft'))} />
                    )}
                  </div>
                  <div className="recipe-editor-cover-workspace">
                    <div className="recipe-editor-cover-toolbar">
                      <div>
                        <h4>菜谱封面</h4>
                        <p>可直接基于菜谱信息生成，也可以上传参考图后生成统一风格主图。</p>
                      </div>
                      <div className="recipe-editor-cover-actions">
                        <button
                          className="ghost-button"
                          type="button"
                          onClick={() => void handleRecipeImageGenerate('text')}
                          disabled={recipeImageState.isGenerating}
                        >
                          {recipeImageState.isGenerating && !form.images.referenceAsset ? '生成中...' : '基于信息生成主图'}
                        </button>
                        <label className={recipeImageState.isGenerating ? 'ghost-button disabled' : 'ghost-button'}>
                          <input
                            type="file"
                            accept="image/*,.svg"
                            capture="environment"
                            disabled={recipeImageState.isGenerating}
                            onChange={(event) => {
                              void handleRecipeImageUpload(event.target.files);
                              event.currentTarget.value = '';
                            }}
                          />
                          上传图片生成
                        </label>
                        {form.images.referenceAsset && (
                          <button
                            className="ghost-button"
                            type="button"
                            onClick={() => void handleRecipeImageGenerate('reference')}
                            disabled={recipeImageState.isGenerating}
                          >
                            {recipeImageState.isGenerating ? '生成中...' : '基于参考图生成'}
                          </button>
                        )}
                        <button className="ghost-button" type="button" onClick={resetRecipeImageInput} disabled={recipeImageState.isGenerating}>
                          清空图片
                        </button>
                      </div>
                    </div>

                    <div className={editorReferenceUrl ? 'recipe-editor-cover-result-grid has-reference' : 'recipe-editor-cover-result-grid'}>
                      {editorReferenceUrl && (
                        <label className="recipe-editor-cover-result recipe-editor-cover-upload-card">
                          <input
                            type="file"
                            accept="image/*,.svg"
                            capture="environment"
                            disabled={recipeImageState.isGenerating}
                            onChange={(event) => {
                              void handleRecipeImageUpload(event.target.files);
                              event.currentTarget.value = '';
                            }}
                          />
                          <div className="recipe-editor-cover-result-head">
                            <span>参考图</span>
                            <small>{recipeImageState.isGenerating ? '正在生成' : '点按更换'}</small>
                          </div>
                          <img src={editorReferenceUrl} alt={`${form.title || '菜谱'}参考图`} />
                        </label>
                      )}
                      <article className="recipe-editor-cover-result">
                        <div className="recipe-editor-cover-result-head">
                          <span>AI 主图</span>
                          <small>{form.images.generatedAsset ? '已生成' : recipeImageState.isGenerating ? '生成中' : '未生成'}</small>
                        </div>
                        {editorGeneratedUrl ? (
                          <img src={editorGeneratedUrl} alt={form.title || '菜谱封面'} />
                        ) : (
                          <div className="recipe-editor-cover-empty">
                            {recipeImageState.isGenerating ? <span className="image-composer-loading-surface" aria-hidden="true" /> : <RecipeUiIcon name="image" />}
                            <strong>{recipeImageState.isGenerating ? '正在生成主图' : '还没有 AI 主图'}</strong>
                            <p>{form.images.referenceAsset ? '参考图已保留，可以重试生成主图。' : '先用文字信息生成，或上传参考图生成。'}</p>
                          </div>
                        )}
                      </article>
                    </div>
                    {recipeImageState.errorMessage && <span className="image-composer-error">{recipeImageState.errorMessage}</span>}
                    <p className="recipe-editor-cover-hint">推荐尺寸：16:9，JPG/PNG，5 MB 以内。</p>
                  </div>
                </div>
              </section>
            </main>

            <aside className="recipe-editor-side-column">
              {!isEditing && (
                <section className="recipe-editor-side-card recipe-ai-draft-panel">
                  <div className="workspace-action-rail-copy">
                    <p className="eyebrow">AI 草稿</p>
                    <h3>用现有食材生成菜谱</h3>
                    <p className="subtle">选择 1-4 个食材，生成后会填入左侧表单。</p>
                  </div>
                  <label>
                    <span>口味方向</span>
                    <input
                      className="text-input"
                      value={recipeDraftAiForm.prompt}
                      placeholder="例如：清淡、适合孩子、少油快手"
                      onChange={(event) => setRecipeDraftAiForm((current) => ({ ...current, prompt: event.target.value }))}
                    />
                  </label>
                  <div className="recipe-ai-ingredient-picker">
                    {recipeDraftIngredientOptions.slice(0, 12).map((ingredient) => (
                      <label key={ingredient.id} className="checkbox-row checkbox-card">
                        <input
                          type="checkbox"
                          checked={recipeDraftAiForm.ingredientIds.includes(ingredient.id)}
                          onChange={(event) => updateRecipeDraftIngredientSelection(ingredient.id, event.target.checked)}
                        />
                        <span>{ingredient.name}</span>
                      </label>
                    ))}
                  </div>
                  {recipeDraftError ? <p className="form-error">{recipeDraftError}</p> : null}
                  <ActionButton
                    tone="secondary"
                    type="button"
                    onClick={() => void generateRecipeDraftFromInventory()}
                    disabled={isRecipeDraftGenerating || props.ingredients.length === 0}
                  >
                    {isRecipeDraftGenerating ? '生成中...' : '生成并填入'}
                  </ActionButton>
                </section>
              )}
              <section className="recipe-editor-side-card recipe-editor-summary-card">
                <div className="recipe-editor-summary-head">
                  <div>
                    <h3>实时摘要</h3>
                    <p className="subtle">{isEditing ? '根据当前表单内容预览' : '保存后进入菜谱工作台'}</p>
                  </div>
                  <span><RecipeUiIcon name="check" /> 表单实时更新</span>
                </div>
                <div className="recipe-editor-live-preview">
                  {editorCoverUrl ? <img src={editorCoverUrl} alt={form.title || '菜谱封面'} /> : <RecipeDishIllustration title={form.title || '菜谱封面'} tone={getRecipeVisualTone(selectedRecipeId ?? (form.title || 'draft'))} />}
                  <div>
                    <strong>{form.title.trim() || '未命名菜谱'}</strong>
                    <p>{form.tips.trim() || '填写技巧说明后，会在这里看到摘要。'}</p>
                  </div>
                </div>
                <div className="recipe-editor-summary-list">
                  <div><span><RecipeUiIcon name="users" /></span><small>份量</small><strong>{form.servings || '2'} 人份</strong></div>
                  <div><span><RecipeUiIcon name="basket" /></span><small>原料</small><strong>{editorIngredientCount} 项</strong></div>
                  <div><span><RecipeUiIcon name="clipboard" /></span><small>步骤</small><strong>{editorStepCount} 步</strong></div>
                  <div><span><RecipeUiIcon name="image" /></span><small>图片</small><strong>{editorCoverAsset ? '已有封面' : '暂未配图'}</strong></div>
                </div>
                {!isEditing && (
                  <label className="checkbox-row checkbox-card">
                    <input type="checkbox" checked={form.autoCreateFood} onChange={(event) => setForm({ ...form, autoCreateFood: event.target.checked })} />
                    <span>保存后自动创建一份“自做菜”食物卡片</span>
                  </label>
                )}
                <div className="recipe-editor-submit-stack">
                  <ActionButton tone="primary" type="submit" disabled={submitDisabled}>
                    {props.isCreatingRecipe || props.isUpdatingRecipe ? '保存中...' : recipeImageState.isGenerating ? '生成封面中...' : '保存菜谱'}
                  </ActionButton>
                  {isEditing && (
                    <ActionButton tone="secondary" type="button" onClick={() => setView('detail')}>
                      预览菜谱
                    </ActionButton>
                  )}
                  <ActionButton tone="secondary" type="button" onClick={() => setView(isEditing ? 'detail' : 'library')}>
                    取消
                  </ActionButton>
                </div>
              </section>

              <section className="recipe-editor-side-card recipe-editor-completion-card">
                <div className="recipe-editor-completion-head">
                  <h3>完成度</h3>
                  <strong>{editorCompletionPercent}%</strong>
                </div>
                <div className="recipe-editor-progress-track">
                  <span style={{ width: `${editorCompletionPercent}%` }} />
                </div>
                <div className="recipe-editor-completion-list">
                  {editorCompletionItems.map((item) => (
                    <span key={item.label} className={item.done ? 'done' : ''}>
                      <RecipeUiIcon name="check" />
                      {item.label}
                    </span>
                  ))}
                </div>
              </section>
            </aside>
          </form>
        </WorkspaceSubpageShell>
      ) : view === 'cook' && activeCookCard && cookSession ? (
        <main className="recipe-cook-page">
          <section className="recipe-cook-hero-panel">
            <div className="recipe-cook-hero-copy">
              <button className="workspace-back-link" type="button" onClick={() => exitCookMode('detail')}>
                <span aria-hidden="true">‹</span>
                返回详情
              </button>
              <h2>{activeCookCard.recipe.title}</h2>
              <p>{activeCookCard.recipe.prep_minutes} 分钟 · {activeCookCard.recipe.servings} 人份 · {DIFFICULTY_LABELS[activeCookCard.recipe.difficulty]}</p>
            </div>
            <div className="recipe-cook-hero-side">
              <div className="recipe-cook-hero-art" aria-hidden="true">
                {activeCookCard.coverUrl ? (
                  <img src={resolveAssetUrl(activeCookCard.coverUrl)} alt="" />
                ) : (
                  <RecipeDishIllustration title={activeCookCard.recipe.title} tone={getRecipeVisualTone(activeCookCard.recipe.id)} />
                )}
              </div>
              <div className="recipe-cook-progress-card">
                <Badge className={`recipe-availability-badge tone-${activeCookCard.availability}`}>{activeCookCard.availabilityLabel}</Badge>
                <strong>{cookProgressPercent}%</strong>
                <span>第 {cookSession.currentStepIndex + 1} / {cookSteps.length} 步</span>
                <ActionButton tone="secondary" type="button" onClick={() => exitCookMode('library')}>
                  退出烹饪
                </ActionButton>
              </div>
            </div>
          </section>

          <div className="recipe-cook-layout">
            <section className="recipe-cook-step-stage">
              <div className="recipe-cook-step-rail" aria-label="步骤进度">
                {cookSteps.map((step, index) => {
                  const isCurrent = index === cookSession.currentStepIndex;
                  const isDone = cookSession.completedStepIds.includes(step.id);
                  return (
                    <button
                      key={step.id}
                      className={`${isCurrent ? 'current ' : ''}${isDone ? 'done' : ''}`.trim()}
                      type="button"
                      onClick={() => jumpToCookStep(index)}
                      aria-current={isCurrent ? 'step' : undefined}
                    >
                      <span>{index + 1}</span>
                      <strong><RecipeUiIcon name={getRecipeStepIconName(step.icon)} />{getRecipeStepTitle(step, index)}</strong>
                    </button>
                  );
                })}
              </div>
              <div className="recipe-cook-step-count">
                <span>当前步骤</span>
                <strong>{cookSession.currentStepIndex + 1}</strong>
              </div>
              <article className={currentCookStep && cookSession.completedStepIds.includes(currentCookStep.id) ? 'recipe-cook-current-step done' : 'recipe-cook-current-step'}>
                <span className="recipe-cook-step-watermark">{String(cookSession.currentStepIndex + 1).padStart(2, '0')}</span>
                <div className="recipe-cook-step-board">
                  <div className="recipe-cook-current-step-copy">
                    <span className="recipe-cook-step-pill">当前步骤 {cookSession.currentStepIndex + 1} / {cookSteps.length}</span>
                    <h3>{getRecipeStepTitle(currentCookStep ?? {}, cookSession.currentStepIndex)}</h3>
                    <p>{currentCookStep?.text}</p>
                    <div className="recipe-cook-step-meta-grid">
                      <div>
                        <RecipeUiIcon name="clock" />
                        <span>预计用时</span>
                        <strong>{currentCookStep?.estimated_minutes ? `${currentCookStep.estimated_minutes} 分钟` : '按需调整'}</strong>
                      </div>
                      {currentCookStep?.tip ? (
                        <div>
                          <RecipeUiIcon name="sparkle" />
                          <span>烹饪小贴士</span>
                          <strong>{currentCookStep.tip}</strong>
                        </div>
                      ) : null}
                    </div>
                    {currentCookStep?.key_points?.length ? (
                      <div className="recipe-cook-key-points">
                        <strong>关键要点</strong>
                        {currentCookStep.key_points.map((point, index) => (
                          <span key={`${point}-${index}`}>{point}</span>
                        ))}
                      </div>
                    ) : null}
                  </div>
                  <div className="recipe-cook-step-overview" aria-label="烹饪顺序">
                    <div className="recipe-cook-step-overview-head">
                      <span>烹饪顺序</span>
                      <strong>{cookSession.currentStepIndex + 1} / {cookSteps.length}</strong>
                    </div>
                    <div className="recipe-cook-step-overview-list">
                      {cookSteps.map((step, index) => {
                        const isCurrent = index === cookSession.currentStepIndex;
                        const isDone = cookSession.completedStepIds.includes(step.id);
                        return (
                          <button
                            key={step.id}
                            className={`${isCurrent ? 'current ' : ''}${isDone ? 'done' : ''}`.trim()}
                            type="button"
                            onClick={() => jumpToCookStep(index)}
                            aria-current={isCurrent ? 'step' : undefined}
                          >
                            <span>{index + 1}</span>
                            <strong><RecipeUiIcon name={getRecipeStepIconName(step.icon)} />{getRecipeStepTitle(step, index)}</strong>
                            <small>{getRecipeStepSummary(step)}</small>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                </div>
              </article>
              <div className="recipe-cook-step-actions">
                <ActionButton tone="secondary" type="button" onClick={() => moveCookStep(-1)} disabled={cookSession.currentStepIndex <= 0}>
                  ‹ 上一步
                </ActionButton>
                <ActionButton tone="primary" type="button" onClick={completeCurrentCookStepAndContinue}>
                  {cookSession.currentStepIndex >= cookSteps.length - 1 ? '完成本步，完成烹饪 ✓' : '完成本步，进入下一步 ›'}
                </ActionButton>
              </div>
            </section>

            <aside className="recipe-cook-side-panel">
              {(wasCookSessionRestored || Boolean(cookPreview?.shortages.length)) && (
                <section className="recipe-cook-status-card">
                  {wasCookSessionRestored && (
                    <div className="recipe-cook-status-row">
                      <span><RecipeUiIcon name="clock" /></span>
                      <div>
                        <strong>已恢复进度</strong>
                        <small>步骤、用料和计时已保存</small>
                      </div>
                      <button type="button" onClick={resetActiveCookSession}>重来</button>
                    </div>
                  )}
                  {cookPreview?.shortages.length ? (
                    <div className="recipe-cook-status-row warning">
                      <span><RecipeUiIcon name="warning" /></span>
                      <div>
                        <strong>缺 {cookPreview.shortages.length} 项</strong>
                        <small>{cookPreview.shortages.map((item) => `${item.ingredient_name} ${formatCookQuantity(item.missing_quantity)}${item.unit}`).join('、')}</small>
                      </div>
                      <button type="button" onClick={() => openShoppingDialog(activeCookCard)} disabled={props.isCreatingShopping}>采购</button>
                    </div>
                  ) : null}
                </section>
              )}
              <section className={`recipe-cook-timer-card ${cookSession.timerMode}${cookSession.timerRunning ? ' running' : ''}${cookTimerJustStarted ? ' started' : ''}${isCookTimerCustomOpen ? ' custom-open' : ''}`}>
                <div className="recipe-cook-timer-head">
                  <div>
                    <span>烹饪计时器</span>
                    <strong>{cookSession.timerMode === 'countdown' ? '倒计时' : '正计时'}</strong>
                  </div>
                  <small>{currentStepSuggestedSeconds ? `建议 ${formatCookTimerDuration(currentStepSuggestedSeconds)}` : '建议时长未设置'}</small>
                </div>
                {isCookTimerCustomOpen ? (
                  <div className="recipe-cook-time-picker-shell">
                    <div className="recipe-cook-time-picker" aria-label="自定义计时时长">
                      <div className="recipe-cook-time-picker-column">
                        <span>分钟</span>
                        <div className="recipe-cook-time-picker-wheel" ref={cookTimerMinuteWheelRef}>
                          {Array.from({ length: 60 }, (_, minute) => (
                            <button
                              key={minute}
                              className={cookTimerPicker.minutes === minute ? 'selected' : ''}
                              type="button"
                              onClick={() => setCookTimerPicker((current) => ({ ...current, minutes: minute }))}
                            >
                              {String(minute).padStart(2, '0')}
                            </button>
                          ))}
                        </div>
                      </div>
                      <div className="recipe-cook-time-picker-separator">:</div>
                      <div className="recipe-cook-time-picker-column">
                        <span>秒</span>
                        <div className="recipe-cook-time-picker-wheel" ref={cookTimerSecondWheelRef}>
                          {Array.from({ length: 60 }, (_, second) => (
                            <button
                              key={second}
                              className={cookTimerPicker.seconds === second ? 'selected' : ''}
                              type="button"
                              onClick={() => setCookTimerPicker((current) => ({ ...current, seconds: second }))}
                            >
                              {String(second).padStart(2, '0')}
                            </button>
                          ))}
                        </div>
                      </div>
                    </div>
                    <div className="recipe-cook-time-picker-preview">
                      <span>已选择</span>
                      <strong>{formatCookTimer(cookTimerPicker.minutes * 60 + cookTimerPicker.seconds)}</strong>
                    </div>
                    <div className="recipe-cook-timer-actions custom-actions">
                      <button type="button" onClick={() => setIsCookTimerCustomOpen(false)}>
                        取消
                      </button>
                      <button className="primary" type="button" onClick={confirmCustomCookTimer} disabled={cookTimerPicker.minutes === 0 && cookTimerPicker.seconds === 0}>
                        <RecipeUiIcon name="play" />
                        确定并开始
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="recipe-cook-timer-body">
                    <div className="recipe-cook-timer-presets" aria-label="计时时长">
                      {COOK_TIMER_PRESETS.map((preset) => {
                        const selected = preset.seconds === 'custom'
                          ? cookSession.timerMode === 'countdown' && Boolean(cookTimerDurationSeconds) && !COOK_TIMER_PRESETS.some((item) => typeof item.seconds === 'number' && item.seconds === cookTimerDurationSeconds)
                          : preset.seconds === null
                          ? cookSession.timerMode === 'countup'
                          : cookSession.timerMode === 'countdown' && cookTimerDurationSeconds === preset.seconds;
                        return (
                          <button
                            key={preset.label}
                            className={selected ? 'selected' : ''}
                            type="button"
                            disabled={cookSession.timerRunning}
                            onClick={() => (preset.seconds === 'custom' ? openCustomCookTimer() : selectCookTimerDuration(preset.seconds))}
                          >
                            {preset.seconds === 'custom' && selected ? formatCookTimer(cookTimerDurationSeconds ?? 0) : preset.label}
                          </button>
                        );
                      })}
                    </div>
                    <div
                      className="recipe-cook-timer-dial"
                      style={{ '--timer-progress': `${cookTimerProgress * 360}deg` } as CSSProperties}
                    >
                      <div>
                        <strong>{formatCookTimer(cookTimerDisplaySeconds)}</strong>
                        <span>{cookSession.timerMode === 'countdown' ? '剩余时间' : '已用时间'}</span>
                      </div>
                    </div>
                    <div className={`recipe-cook-timer-actions ${cookSession.timerMode === 'countdown' ? 'countdown' : 'countup'}`}>
                      <button type="button" onClick={resetCookTimer}>
                        <RecipeUiIcon name="reset" />
                        重置
                      </button>
                      <button className="primary" type="button" onClick={toggleCookTimer}>
                        <RecipeUiIcon name={cookSession.timerRunning ? 'pause' : 'play'} />
                        {cookSession.timerRunning ? '暂停' : '开始'}
                      </button>
                      {cookSession.timerMode === 'countdown' ? (
                        <button type="button" onClick={() => addCookTimerSeconds(30)}>
                          <RecipeUiIcon name="plusThirty" />
                          +30秒
                        </button>
                      ) : null}
                    </div>
                  </div>
                )}
              </section>

              <section className="recipe-cook-ingredients-card">
                <div className="recipe-cook-panel-head">
                  <h3>用料清单</h3>
                  <span>{cookSession.checkedIngredientIds.length} / {activeCookCard.recipe.ingredient_items.length}</span>
                </div>
                <div className="recipe-cook-ingredient-checklist">
                  {activeCookCard.recipe.ingredient_items.map((item) => {
                    const checked = cookSession.checkedIngredientIds.includes(item.id);
                    const availability = activeCookCard.ingredientAvailability.find((entry) => entry.item.id === item.id);
                    return (
                      <button key={item.id} className={checked ? 'checked' : ''} type="button" onClick={() => toggleCookIngredient(item.id)}>
                        <span>{checked ? <RecipeUiIcon name="check" /> : null}</span>
                        <strong>{item.ingredient_name}</strong>
                        <small className={availability?.ready ? 'ready' : availability ? 'missing' : ''}>
                          {item.quantity}{item.unit}{availability?.ready ? ' · 已备齐' : availability ? ` · 缺 ${availability.missingQuantity}${availability.unit}` : ''}
                        </small>
                      </button>
                    );
                  })}
                </div>
              </section>
            </aside>
          </div>

          <div className="recipe-cook-bottom-bar">
            <ActionButton tone="secondary" type="button" onClick={() => moveCookStep(-1)} disabled={cookSession.currentStepIndex <= 0}>‹ 上一步</ActionButton>
            <ActionButton tone="secondary" type="button" onClick={() => openShoppingDialog(activeCookCard)} disabled={props.isCreatingShopping}>加采购</ActionButton>
            <ActionButton tone="primary" type="button" onClick={() => setIsCookFinishOpen(true)}>
              ✓ 完成烹饪
            </ActionButton>
          </div>
        </main>
      ) : view === 'detail' && selectedCard ? (
        <WorkspaceSubpageShell className="recipe-detail-subpage">
          <div className="recipe-detail-topbar">
            <button className="workspace-back-link recipe-detail-back-link" type="button" onClick={() => setView('library')}>
              <RecipeUiIcon name="chevronLeft" />
              返回菜谱
            </button>
            <Badge className={`recipe-availability-badge tone-${selectedCard.availability}`}>
              {selectedCard.availabilityLabel}
            </Badge>
          </div>

          <section className="recipe-detail-hero-panel">
            <div className="recipe-detail-title-block">
              <p className="eyebrow">菜谱资料</p>
              <h2>{selectedCard.recipe.title}</h2>
              <p className="recipe-detail-meta-line">
                {selectedCard.recipe.prep_minutes} 分钟 · {selectedCard.recipe.servings} 人份 · {selectedCard.availabilityLabel}
              </p>
            </div>

            <div className="recipe-detail-hero-grid">
              <RecipeCover card={selectedCard} className="recipe-detail-cover" />
              <div className="recipe-detail-hero-copy">
                <div className="recipe-detail-tags">
                  {selectedSceneTags.slice(0, 4).map((tag) => (
                    <span key={tag} className="chip recipe-chip">{tag}</span>
                  ))}
                </div>
                <p>{selectedCard.recipe.tips || '这份菜谱还没有补充烹饪提示，可以在编辑里记录口味、火候和替换建议。'}</p>
                <div className="recipe-detail-metric-row">
                  <span>
                    <RecipeUiIcon name="clock" />
                    <strong>{selectedCard.recipe.prep_minutes}</strong>
                    分钟
                  </span>
                  <span>
                    <RecipeUiIcon name="users" />
                    <strong>{selectedCard.recipe.servings}</strong>
                    人份
                  </span>
                  <span>
                    <RecipeUiIcon name="signal" />
                    <strong>{DIFFICULTY_LABELS[selectedCard.recipe.difficulty]}</strong>
                    难度
                  </span>
                  <span>
                    <RecipeUiIcon name="reset" />
                    <strong>{selectedCard.mealUsageCount}</strong>
                    次复做
                  </span>
                </div>
                <div className="recipe-detail-actions">
                  <ActionButton tone="primary" type="button" onClick={() => openCook(selectedCard)}>
                    <RecipeUiIcon name="play" />
                    开始做
                  </ActionButton>
                  <ActionButton tone="secondary" type="button" onClick={() => openPlanDialog(selectedCard)}>
                    <RecipeUiIcon name="calendar" />
                    加入计划
                  </ActionButton>
                  <ActionButton tone="secondary" type="button" onClick={() => openShoppingDialog(selectedCard)} disabled={props.isCreatingShopping}>
                    <RecipeUiIcon name="basket" />
                    加入采购
                  </ActionButton>
                  <ActionButton tone="secondary" type="button" onClick={() => void toggleRecipeFavorite(selectedCard)} disabled={props.isUpdatingFavorite}>
                    <RecipeUiIcon name="star" />
                    {isSelectedFavorite ? '已收藏' : '收藏'}
                  </ActionButton>
                  <ActionButton tone="secondary" type="button" onClick={() => openEdit(selectedCard)}>
                    <RecipeUiIcon name="edit" />
                    编辑
                  </ActionButton>
                </div>
              </div>
            </div>
          </section>

          <div className="recipe-detail-content-grid">
            <main className="recipe-detail-main-column">
              <section className="recipe-detail-section recipe-detail-ingredients-section">
                <div className="recipe-detail-section-head">
                  <span><RecipeUiIcon name="basket" /></span>
                  <div>
                    <h3>用料与库存</h3>
                    <p>根据当前库存判断，缺 {selectedShortageCount} 项</p>
                  </div>
                </div>
                {selectedCard.ingredientAvailability.length > 0 ? (
                  <div className="recipe-detail-ingredient-table">
                    <div className="recipe-detail-ingredient-head">
                      <span>食材与处理</span>
                      <span>需要量</span>
                      <span>备注</span>
                      <span>库存状态</span>
                    </div>
                    {selectedCard.ingredientAvailability.map((item) => (
                      <article key={item.item.id} className="recipe-detail-ingredient-row">
                        <div className="recipe-detail-ingredient-name">
                          <img src={resolveIngredientImageUrl(item.ingredient, item.item.ingredient_name)} alt={item.item.ingredient_name} />
                          <strong>{item.item.ingredient_name}</strong>
                        </div>
                        <span>{item.item.quantity}{item.item.unit}</span>
                        <span>{item.item.note || '搭配主食'}</span>
                        <Badge className={item.ready ? 'recipe-stock-badge ready' : 'recipe-stock-badge missing'}>
                          {item.ready ? '已备齐' : `缺 ${item.missingQuantity}${item.unit}`}
                        </Badge>
                      </article>
                    ))}
                  </div>
                ) : (
                  <p className="subtle">还没有录入用料。</p>
                )}
              </section>

              <section className="recipe-detail-section">
                <div className="recipe-detail-section-head">
                  <span><RecipeUiIcon name="clipboard" /></span>
                  <div>
                    <h3>做法步骤</h3>
                    <p>按顺序完成关键步骤</p>
                  </div>
                </div>
                <ol className="recipe-detail-step-timeline">
                  {selectedCard.recipe.steps.length > 0 ? selectedCard.recipe.steps.map((step, index) => (
                    <li key={step.id}>
                      <span className="recipe-detail-step-index">{index + 1}</span>
                      <div>
                        <strong>{getRecipeStepTitle(step, index)}</strong>
                        <p>{getRecipeStepSummary(step)}</p>
                        {step.tip ? <small>{step.tip}</small> : null}
                      </div>
                      {step.estimated_minutes ? <Badge>约 {step.estimated_minutes} 分钟</Badge> : null}
                    </li>
                  )) : (
                    <li>
                      <span className="recipe-detail-step-index">1</span>
                      <div>
                        <strong>还没有步骤</strong>
                        <p>可以在编辑里补充烹饪流程。</p>
                      </div>
                    </li>
                  )}
                </ol>
              </section>

              <section className="recipe-detail-section">
                <div className="recipe-detail-section-head">
                  <span><RecipeUiIcon name="sparkle" /></span>
                  <div>
                    <h3>烹饪提示与复做记录</h3>
                    <p>把口味调整和家人反馈留在这里</p>
                  </div>
                </div>
                <div className="recipe-detail-note-grid">
                  <article>
                    <h4>烹饪提示</h4>
                    <p>{selectedCard.recipe.tips || '暂无额外提示。'}</p>
                  </article>
                  <article>
                    <h4>最近复做反馈</h4>
                    {selectedRecentCookLog ? (
                      <>
                        <p>
                          {formatDate(selectedRecentCookLog.cook_date)} · {selectedRecentCookLog.adjustments || selectedRecentCookLog.result_note || '这次没有额外记录。'}
                        </p>
                        <div className="recipe-detail-note-footer">
                          <span>{MEAL_TYPE_LABELS[selectedRecentCookLog.meal_type]}</span>
                          <Badge>{selectedRecentCookLog.rating ? `${selectedRecentCookLog.rating}/5` : `${selectedRecentCookLog.servings} 人份`}</Badge>
                        </div>
                      </>
                    ) : (
                      <p>做完一次后，这里会留下本次调整和满意度。</p>
                    )}
                  </article>
                </div>
              </section>
            </main>

            <aside className="recipe-detail-side-column">
              <section className="recipe-detail-side-card">
                <div className="recipe-detail-section-head">
                  <span><RecipeUiIcon name="basket" /></span>
                  <div>
                    <h3>库存判断</h3>
                    <p>当前库存覆盖 {selectedReadyCount} / {selectedIngredientCount} 项</p>
                  </div>
                </div>
                <div className={`recipe-detail-stock-summary tone-${selectedCard.availability}`}>
                  <span><RecipeUiIcon name={selectedShortageCount > 0 ? 'warning' : 'check'} /></span>
                  <strong>{selectedShortageCount > 0 ? '需要先补齐食材' : '可以立即开始'}</strong>
                  <small>共需 {selectedIngredientCount} 项食材，缺 {selectedShortageCount} 项</small>
                </div>
                {selectedCard.shortages.length > 0 ? (
                  <div className="recipe-detail-shortage-list">
                    <strong>缺少食材</strong>
                    {selectedCard.shortages.slice(0, 3).map((item) => (
                      <span key={`${item.ingredientName}-${item.unit}`}>· {item.ingredientName} {item.missingQuantity}{item.unit}</span>
                    ))}
                  </div>
                ) : (
                  <p className="subtle">主要用料已经备齐。</p>
                )}
                <button className="recipe-detail-link-button" type="button" onClick={() => openShoppingDialog(selectedCard)}>
                  查看采购清单 <RecipeUiIcon name="chevronRight" />
                </button>
              </section>

              <section className="recipe-detail-side-card recipe-detail-plan-card">
                <div className="recipe-detail-section-head">
                  <span><RecipeUiIcon name="calendar" /></span>
                  <div>
                    <h3>菜谱计划</h3>
                    <p>{selectedRecipePlanItems.length > 0 ? `已加入 ${selectedRecipePlanItems.length} 个计划` : '将此菜谱加入本周计划'}</p>
                  </div>
                </div>
                <ActionButton tone="secondary" size="compact" type="button" onClick={() => openPlanDialog(selectedCard)}>
                  加入计划
                </ActionButton>
              </section>

              <section className="recipe-detail-side-card">
                <div className="recipe-detail-section-head">
                  <span><RecipeUiIcon name="info" /></span>
                  <div>
                    <h3>菜谱信息</h3>
                  </div>
                </div>
                <dl className="recipe-detail-info-list">
                  <div><dt>最近更新</dt><dd>{formatDateTime(selectedCard.recipe.updated_at)}</dd></div>
                  <div><dt>创建时间</dt><dd>{formatDateTime(selectedCard.recipe.created_at)}</dd></div>
                  <div><dt>创建者</dt><dd>{selectedCard.recipe.created_by || '家庭成员'}</dd></div>
                  <div><dt>来源/备注</dt><dd>{selectedCard.linkedFood ? selectedCard.linkedFood.name : '家庭自制菜谱'}</dd></div>
                </dl>
                <ActionButton tone="tertiary" size="compact" type="button" onClick={() => void deleteSelectedRecipe()} disabled={props.isDeletingRecipe}>
                  删除菜谱
                </ActionButton>
              </section>

              <section className="recipe-detail-side-card">
                <div className="recipe-detail-section-head">
                  <span><RecipeUiIcon name="tag" /></span>
                  <div>
                    <h3>适合场景</h3>
                  </div>
                </div>
                <div className="recipe-detail-side-tags">
                  {selectedSceneTags.map((tag) => (
                    <span key={tag} className="chip recipe-chip">{tag}</span>
                  ))}
                </div>
              </section>
            </aside>
          </div>
        </WorkspaceSubpageShell>
      ) : (
        <div className="recipe-discovery-page">
          <section className="recipe-discovery-shell">
            <div className="recipe-discovery-hero">
              <div>
                <h2>菜谱<RecipeUiIcon name="leaf" className="recipe-title-mark" /></h2>
                <p>发现灵感，轻松做出美味每一餐</p>
              </div>
              <ActionButton tone="primary" type="button" onClick={openCreate} className="recipe-create-button">
                <span><RecipeUiIcon name="plus" /></span>
                新建菜谱
              </ActionButton>
            </div>

            <div className="recipe-inspiration-grid">
              <article className="recipe-inspiration-card compact-gallery">
                <div className="recipe-inspiration-head">
                  <h3 className="recipe-inspiration-title"><RecipeUiIcon name="clock" />最近做过</h3>
                  <button type="button" onClick={() => showDiscoveryFilter('common', { sort: 'updated' })}>查看全部</button>
                </div>
                <div className="recipe-mini-gallery">
                  {recentPreviewSlots.map((card, index) => (
                    card ? (
                      <RecipeMiniThumb key={`${card.recipe.id}-${index}`} card={card} onClick={() => openDetail(card)} />
                    ) : (
                      <RecipeMiniPlaceholder key={`recent-empty-${index}`} />
                    )
                  ))}
                </div>
              </article>
              <article className="recipe-inspiration-card top-list">
                <div className="recipe-inspiration-head">
                  <h3 className="recipe-inspiration-title"><RecipeUiIcon name="flame" />本周常做 <span>TOP3</span></h3>
                </div>
                <div className="recipe-top-list">
                  {topPreviewSlots.map((item, index) => (
                    item ? (
                      <RecipeTopItem key={`${item.card.recipe.id}-${index}`} card={item.card} rank={index + 1} count={item.count} onClick={() => openDetail(item.card)} />
                    ) : (
                      <RecipeTopPlaceholder key={`top-empty-${index}`} rank={index + 1} />
                    )
                  ))}
                </div>
              </article>
              <article className="recipe-inspiration-card compact-gallery">
                <div className="recipe-inspiration-head">
                  <h3 className="recipe-inspiration-title"><RecipeUiIcon name="zap" />快手菜 <span>10-20 分钟搞定</span></h3>
                  <button
                    type="button"
                    onClick={() => showDiscoveryFilter('quick', { sort: 'time' })}
                  >
                    更多 <RecipeUiIcon name="chevronRight" />
                  </button>
                </div>
                <div className="recipe-mini-gallery quick">
                  {quickPreviewSlots.map((card, index) => (
                    card ? (
                      <RecipeMiniThumb key={`${card.recipe.id}-${index}`} card={card} onClick={() => openDetail(card)} />
                    ) : (
                      <RecipeMiniPlaceholder key={`quick-empty-${index}`} />
                    )
                  ))}
                </div>
              </article>
            </div>
          </section>

          <div className="recipe-discovery-layout">
            <main className="recipe-discovery-main">
              {renderFilters()}
              <section className="recipe-discovery-section recipe-recommendation-section" ref={discoverySectionRef}>
                <div className="recipe-discovery-section-head">
                  <div>
                    <h3>{activeDiscoveryCopy.title}<RecipeUiIcon name="sparkle" className="recipe-heading-icon" /></h3>
                    <p className="subtle">{activeDiscoveryCopy.description}</p>
                  </div>
                  <div className="recipe-discovery-section-actions">
                    {sceneFilter !== 'all' && (
                      <ActionButton tone="secondary" size="compact" type="button" onClick={() => setSceneFilter('all')}>
                        清除场景
                      </ActionButton>
                    )}
                    {shouldPageRecommendations && (
                      <ActionButton tone="secondary" size="compact" type="button" onClick={() => setRecommendationPage((current) => current + 1)}>
                        换一换
                      </ActionButton>
                    )}
                  </div>
                </div>
                {displayCards.length > 0 ? (
                  <div
                    className={[
                      'recipe-discovery-card-scroll-shell',
                      'is-paged',
                      discoveryScrollState.canLeft ? 'can-left' : '',
                      discoveryScrollState.canRight ? 'can-right' : '',
                    ]
                      .filter(Boolean)
                      .join(' ')}
                  >
                    {shouldScrollDiscoveryCards && discoveryScrollState.canLeft && (
                      <button className="recipe-discovery-scroll-cue left" type="button" aria-label="向左滑动菜谱" onClick={() => scrollDiscoveryCards('left')}>
                        <RecipeUiIcon name="chevronLeft" />
                      </button>
                    )}
                    <div className="recipe-discovery-card-grid" ref={discoveryScrollRef} onScroll={updateDiscoveryScrollState}>
                      {recommendationSlots.map((card, index) => (
                        <DiscoveryRecipeCard
                          key={`${card.recipe.id}-${index}`}
                          card={card}
                          isFavorite={homeViewModel.favoriteRecipeIds.has(card.recipe.id)}
                          isFavoritePending={props.isUpdatingFavorite}
                          onDetail={() => openDetail(card)}
                          onFavorite={() => void toggleRecipeFavorite(card)}
                          onCook={() => openCook(card)}
                          onPlan={() => openPlanDialog(card)}
                        />
                      ))}
                    </div>
                    {shouldScrollDiscoveryCards && discoveryScrollState.canRight && (
                      <button className="recipe-discovery-scroll-cue right" type="button" aria-label="向右滑动菜谱" onClick={() => scrollDiscoveryCards('right')}>
                        <RecipeUiIcon name="chevronRight" />
                      </button>
                    )}
                  </div>
                ) : (
                  <EmptyState
                    title={props.recipes.length === 0 ? '还没有菜谱' : activeDiscoveryCopy.emptyTitle}
                    description={props.recipes.length === 0 ? '先新增几份常做菜，之后会按库存和记录推荐。' : activeDiscoveryCopy.emptyDescription}
                    action={
                      <ActionButton tone="primary" type="button" onClick={openCreate}>
                        新增菜谱
                      </ActionButton>
                    }
                  />
                )}
              </section>

              <section className="recipe-discovery-section recipe-category-section">
                <div className="recipe-discovery-section-head">
                  <div>
                    <h3>按场景探索<RecipeUiIcon name="flame" className="recipe-heading-icon" /></h3>
                    <p className="subtle">从菜谱场景标签中整理</p>
                  </div>
                  <ActionButton tone="secondary" size="compact" type="button" onClick={() => setIsSceneManagerOpen(true)}>
                    场景管理
                  </ActionButton>
                </div>
                <div
                  className={[
                    'recipe-category-scroll-shell',
                    categoryScrollState.canLeft ? 'can-left' : '',
                    categoryScrollState.canRight ? 'can-right' : '',
                  ]
                    .filter(Boolean)
                    .join(' ')}
                >
                  {categoryScrollState.canLeft && (
                    <button className="recipe-category-scroll-cue left" type="button" aria-label="向左滑动分类" onClick={() => scrollCategories('left')}>
                      <RecipeUiIcon name="chevronLeft" />
                    </button>
                  )}
                  <div className="recipe-category-cloud" ref={categoryScrollRef} onScroll={updateCategoryScrollState}>
                    {categoryCards.length > 0 ? (
                      categoryCards.map((category) => (
                        <button
                          key={category.name}
                          className={sceneFilter === category.name ? 'recipe-category-large active' : 'recipe-category-large'}
                          type="button"
                          onClick={() => {
                            setSceneFilter(sceneFilter === category.name ? 'all' : category.name);
                            setRecommendationPage(0);
                          }}
                        >
                          {category.imageAssetUrl ? <img src={resolveAssetUrl(category.imageAssetUrl)} alt="" /> : <span className="recipe-category-image-placeholder"><RecipeUiIcon name="sparkle" /></span>}
                          <strong>{category.name}</strong>
                          <span>{category.description || (category.count > 0 ? `${category.count} 道菜谱` : '推荐场景')}</span>
                        </button>
                      ))
                    ) : (
                      <span className="subtle">暂无分类</span>
                    )}
                  </div>
                  {categoryScrollState.canRight && (
                    <button className="recipe-category-scroll-cue right" type="button" aria-label="向右滑动分类" onClick={() => scrollCategories('right')}>
                      <RecipeUiIcon name="chevronRight" />
                    </button>
                  )}
                </div>
              </section>
            </main>

            <aside className="recipe-discovery-side">
              <section className="recipe-side-panel">
                <div className="recipe-side-panel-head">
                  <h3><RecipeSideIcon name="heart" />我的收藏</h3>
                  <button type="button" aria-label="查看收藏" onClick={() => showDiscoveryFilter('favorite', { sort: 'updated' })}>
                    <RecipeUiIcon name="chevronRight" />
                  </button>
                </div>
                <div className="recipe-side-list">
                  {favoriteSidebarCards.length > 0 ? (
                    favoriteSidebarCards.map((card) => (
                      <button key={card.recipe.id} className="recipe-side-list-item" type="button" onClick={() => openDetail(card)}>
                        <RecipeCover card={card} className="recipe-side-thumb" />
                        <span>
                          <strong>{card.recipe.title}</strong>
                          <small>{homeViewModel.favoriteRecipeIds.has(card.recipe.id) ? '已收藏' : '推荐收藏'}</small>
                        </span>
                      </button>
                    ))
                  ) : (
                    <p className="subtle">还没有收藏菜谱。</p>
                  )}
                </div>
              </section>

              <section className="recipe-side-panel" ref={planSectionRef}>
                <div className="recipe-side-panel-head">
                  <h3><RecipeSideIcon name="calendar" />我的菜单计划</h3>
                  <button type="button" onClick={showPlanSection}>查看全部</button>
                </div>
                <div className="recipe-plan-switcher" aria-label="切换菜单周">
                  <button type="button" onClick={props.onRecipePlanPreviousWeek}>
                    <RecipeUiIcon name="chevronLeft" />
                    上一周
                  </button>
                  <button type="button" onClick={props.onRecipePlanCurrentWeek} className={isCurrentPlanWeek ? 'active' : ''}>
                    本周
                  </button>
                  <button type="button" onClick={props.onRecipePlanNextWeek}>
                    下一周
                    <RecipeUiIcon name="chevronRight" />
                  </button>
                </div>
                <div className="recipe-plan-range">
                  <span>{planWeekLabel}</span>
                  <strong>{props.recipePlanWeekRange.start.slice(5).replace('-', '/')} - {props.recipePlanWeekRange.end.slice(5).replace('-', '/')}</strong>
                  <small>{plannedDayCount} 天已安排</small>
                </div>
                <ActionButton
                  tone="primary"
                  type="button"
                  className="recipe-plan-add-button"
                  onClick={() => openPlanDialog()}
                  disabled={props.isUpdatingPlan || cards.length === 0}
                >
                  加菜
                </ActionButton>
                <div className="recipe-plan-week">
                  {visiblePlanDays.map((day) => (
                    <div key={day.date} className="recipe-plan-day">
                      <div className="recipe-plan-day-head">
                        <strong>{day.label}</strong>
                        <span>{formatDate(day.date).replace('周', '')}</span>
                      </div>
                      {day.items.length > 0 ? (
                        day.items.map((item) => (
                          <article key={item.id} className="recipe-plan-item">
                            <div>
                              <strong>{item.recipe_title}</strong>
                              <span>
                                {MEAL_TYPE_LABELS[item.meal_type]}
                                {item.status === 'cooked' ? ' · 已完成' : ''}
                              </span>
                            </div>
                            <div className="recipe-plan-item-controls">
                              {item.status !== 'cooked' && (
                                <button
                                  type="button"
                                  disabled={props.isCookingRecipe}
                                  onClick={() => {
                                    const card = cards.find((entry) => entry.recipe.id === item.recipe_id);
                                    if (card) openCook(card, item.id);
                                  }}
                                >
                                  开始做
                                </button>
                              )}
                              <select
                                className="text-input"
                                value={item.plan_date}
                                onChange={(event) => void updatePlanDate(item, event.target.value)}
                                disabled={props.isUpdatingPlan || item.status === 'cooked'}
                              >
                                {planDays.map((option) => (
                                  <option key={option.date} value={option.date}>
                                    {option.label}
                                  </option>
                                ))}
                              </select>
                              <select
                                className="text-input"
                                value={item.meal_type}
                                onChange={(event) => void updatePlanMealType(item, event.target.value as MealType)}
                                disabled={props.isUpdatingPlan || item.status === 'cooked'}
                              >
                                {MEAL_TYPE_OPTIONS.map((option) => (
                                  <option key={option.value} value={option.value}>
                                    {option.label}
                                  </option>
                                ))}
                              </select>
                              <button type="button" onClick={() => void deletePlanItem(item)} disabled={props.isUpdatingPlan}>
                                ×
                              </button>
                            </div>
                          </article>
                        ))
                      ) : (
                        <div className="recipe-plan-empty-row">未安排</div>
                      )}
                    </div>
                  ))}
                  {hiddenPlanDayCount > 0 && <div className="recipe-plan-collapsed-note">其余 {hiddenPlanDayCount} 天已收起</div>}
                </div>
              </section>
            </aside>
          </div>
        </div>
      )}

      {isPlanDialogOpen && (
        <div className="workspace-overlay-root">
          <div className="workspace-overlay-backdrop" onClick={closePlanDialog} />
          <WorkspaceModal
            title={planDialogCard ? `加菜：${planDialogCard.recipe.title}` : '加菜到菜单'}
            description="选择日期和餐次后加入当前周菜单。"
            eyebrow="菜单计划"
            onClose={closePlanDialog}
            className="recipe-plan-modal"
          >
          <form className="recipe-plan-dialog-form" onSubmit={submitPlanItem}>
            <div className="recipe-plan-dialog-hero">
              <div className="recipe-plan-selected-cover">
                {planDialogCard ? (
                  <RecipeCover card={planDialogCard} />
                ) : (
                  <div className="recipe-plan-cover-empty">
                    <RecipeUiIcon name="clipboard" />
                  </div>
                )}
              </div>
              <div>
                <span className="recipe-plan-dialog-kicker">即将加入</span>
                <strong>{planDialogCard?.recipe.title ?? '选择一道菜'}</strong>
                <p>{planDialogCard ? `${planDialogCard.recipe.prep_minutes} 分钟 · ${planDialogCard.recipe.servings} 人份 · ${DIFFICULTY_LABELS[planDialogCard.recipe.difficulty]}` : '搜索菜名、食材或场景标签，找到要安排的菜谱。'}</p>
              </div>
            </div>

            <div className="recipe-plan-picker">
              <label htmlFor="recipe-plan-search">选择菜谱</label>
              <div className="recipe-plan-combobox">
                <RecipeUiIcon name="search" />
                <input
                  id="recipe-plan-search"
                  className="recipe-plan-search-input"
                  value={isPlanRecipePickerOpen || planRecipeSearch ? planRecipeSearch : planDialogCard?.recipe.title ?? ''}
                  placeholder="搜索菜谱、食材或标签"
                  onFocus={() => {
                    setPlanRecipeSearch('');
                    setIsPlanRecipePickerOpen(true);
                  }}
                  onChange={(event) => {
                    setPlanRecipeSearch(event.target.value);
                    setIsPlanRecipePickerOpen(true);
                  }}
                />
                <button
                  type="button"
                  className="recipe-plan-picker-toggle"
                  aria-label="展开菜谱列表"
                  onClick={() => setIsPlanRecipePickerOpen((current) => !current)}
                >
                  <RecipeUiIcon name="chevronDown" className={isPlanRecipePickerOpen ? 'is-open' : undefined} />
                </button>
              </div>
              {isPlanRecipePickerOpen && (
                <div className="recipe-plan-option-panel">
                  {planRecipeOptions.length > 0 ? (
                    planRecipeOptions.slice(0, 8).map((card) => (
                      <button
                        key={card.recipe.id}
                        type="button"
                        className={card.recipe.id === planForm.recipeId ? 'recipe-plan-option active' : 'recipe-plan-option'}
                        onClick={() => selectPlanRecipe(card)}
                      >
                        <RecipeCover card={card} className="recipe-plan-option-cover" />
                        <span>
                          <strong>{card.recipe.title}</strong>
                          <small>{card.recipe.prep_minutes} 分钟 · {card.recipe.servings} 人份 · {card.ingredientPreview.slice(0, 3).join('、') || '暂无原料'}</small>
                        </span>
                        <Badge className={`recipe-plan-option-status tone-${card.availability}`}>{card.availabilityLabel}</Badge>
                      </button>
                    ))
                  ) : (
                    <div className="recipe-plan-option-empty">没有找到匹配的菜谱</div>
                  )}
                </div>
              )}
            </div>

            <div className="recipe-plan-form-row">
              <label>
                <span>计划日期</span>
                <input
                  className="text-input"
                  type="date"
                  value={planForm.planDate}
                  min={props.recipePlanWeekRange.start}
                  max={props.recipePlanWeekRange.end}
                  onChange={(event) => setPlanForm({ ...planForm, planDate: event.target.value })}
                />
              </label>
              <label>
                <span>餐次</span>
                <select
                  className="text-input"
                  value={planForm.mealType}
                  onChange={(event) => setPlanForm({ ...planForm, mealType: event.target.value as MealType })}
                >
                  {MEAL_TYPE_OPTIONS.map((item) => (
                    <option key={item.value} value={item.value}>
                      {item.label}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <label className="recipe-plan-note-field">
              <span>备注</span>
              <input
                className="text-input"
                value={planForm.note}
                placeholder="比如：少油、提前解冻、留一份便当"
                onChange={(event) => setPlanForm({ ...planForm, note: event.target.value })}
              />
            </label>
            <div className="workspace-overlay-actions">
              <ActionButton tone="primary" type="submit" disabled={props.isUpdatingPlan || cards.length === 0 || !planForm.recipeId}>
                加入菜单
              </ActionButton>
              <ActionButton tone="secondary" type="button" onClick={closePlanDialog}>
                取消
              </ActionButton>
            </div>
          </form>
          </WorkspaceModal>
        </div>
      )}

      {shoppingDialogCard && (
        <div className="workspace-overlay-root">
          <div className="workspace-overlay-backdrop" onClick={closeShoppingDialog} />
          <WorkspaceModal
            title={`加入采购：${shoppingDialogCard.recipe.title}`}
            description="先确认要买什么，再加入采购清单。"
            eyebrow="采购确认"
            closeLabel="×"
            closeAriaLabel="关闭采购确认"
            onClose={closeShoppingDialog}
            className="recipe-shopping-modal"
          >
            <div className="recipe-shopping-dialog">
              <section className="recipe-shopping-draft-section">
                <div className="recipe-shopping-section-head">
                  <div>
                    <h3>待加入采购清单</h3>
                    <p>缺料已自动列出，可改数量或删除。</p>
                  </div>
                  <Badge>{shoppingDrafts.length} 项</Badge>
                </div>
                {shoppingDrafts.length > 0 ? (
                  <div className="recipe-shopping-draft-list">
                    {shoppingDrafts.map((item) => (
                      <article key={item.id} className="recipe-shopping-draft-row">
                        <div className="recipe-shopping-media">
                          <img
                            src={resolveIngredientImageUrl(
                              props.ingredients.find((ingredient) => ingredient.name === item.title) ?? null,
                              item.title
                            )}
                            alt={item.title || '采购项'}
                          />
                        </div>
                        <div className="recipe-shopping-draft-main">
                          <div className="recipe-shopping-draft-title">
                            <strong>{item.title || '未命名食材'}</strong>
                            <span className={`recipe-shopping-pill tone-${item.requirement}`}>{buildShoppingRequirementLabel(item.requirement)}</span>
                            <span className="recipe-shopping-pill">{buildShoppingDraftSourceLabel(item.source)}</span>
                          </div>
                          <input
                            className="text-input"
                            value={item.title}
                            placeholder="采购项名称"
                            onChange={(event) => updateShoppingDraft(item.id, { title: event.target.value })}
                          />
                        </div>
                        <div className="recipe-shopping-draft-controls">
                          <div className="recipe-shopping-stepper" aria-label={`${item.title} 数量`}>
                            <button type="button" onClick={() => adjustShoppingDraftQuantity(item.id, -1)} aria-label={`${item.title} 数量减一`}>
                              <RecipeUiIcon name="minus" />
                            </button>
                            <input
                              value={item.quantity}
                              inputMode="decimal"
                              onChange={(event) => updateShoppingDraft(item.id, { quantity: event.target.value })}
                            />
                            <button type="button" onClick={() => adjustShoppingDraftQuantity(item.id, 1)} aria-label={`${item.title} 数量加一`}>
                              <RecipeUiIcon name="plus" />
                            </button>
                          </div>
                          <div className="recipe-shopping-select-shell">
                            <select
                              value={item.unit}
                              onChange={(event) => updateShoppingDraft(item.id, { unit: event.target.value })}
                              aria-label={`${item.title} 单位`}
                            >
                              {[item.unit, ...SHOPPING_UNIT_OPTIONS].filter((unit, index, list) => unit && list.indexOf(unit) === index).map((unit) => (
                                <option key={unit} value={unit}>{unit}</option>
                              ))}
                            </select>
                            <RecipeUiIcon name="chevronDown" />
                          </div>
                          <button className="recipe-shopping-delete-button" type="button" onClick={() => removeShoppingDraft(item.id)}>删除</button>
                        </div>
                      </article>
                    ))}
                  </div>
                ) : (
                  <EmptyState title="还没有待加入项" description="可以从下方已有食材点加号，或添加任意食材。" />
                )}
              </section>

              <section className="recipe-shopping-candidate-section">
                <div className="recipe-shopping-section-head compact">
                  <div>
                    <h3>菜谱已有食材</h3>
                    <p>空间压缩显示，点加号也可加入采购。</p>
                  </div>
                </div>
                <div className="recipe-shopping-candidate-list">
                  {shoppingDialogCard.recipe.ingredient_items.map((item) => {
                    const availability = buildRecipeIngredientAvailabilityMap(shoppingDialogCard).get(item.id);
                    const alreadyAdded = shoppingDrafts.some((draft) => draft.recipeIngredientId === item.id);
                    const requirement = getRecipeShoppingRequirement(item);
                    const linkedIngredient = item.ingredient_id ? props.ingredients.find((ingredient) => ingredient.id === item.ingredient_id) ?? null : null;
                    return (
                      <article key={item.id} className="recipe-shopping-candidate-row">
                        <div className="recipe-shopping-candidate-media">
                          <img src={resolveIngredientImageUrl(linkedIngredient, item.ingredient_name)} alt={item.ingredient_name} />
                        </div>
                        <div>
                          <strong>{item.ingredient_name}</strong>
                          <span>
                            {formatShoppingQuantity(item.quantity)}{item.unit} · {buildShoppingRequirementLabel(requirement)} ·{' '}
                            {availability?.ready ? '已有' : availability ? `缺 ${formatShoppingQuantity(availability.missingQuantity)}${availability.unit}` : '未匹配库存'}
                          </span>
                        </div>
                        <button type="button" disabled={alreadyAdded} onClick={() => addRecipeIngredientToShoppingDraft(item)}>
                          {alreadyAdded ? '已加入' : <RecipeUiIcon name="plus" />}
                        </button>
                      </article>
                    );
                  })}
                </div>
              </section>

              <section className="recipe-shopping-custom-section">
                <div className="recipe-shopping-section-head compact">
                  <div>
                    <h3>添加任意食材</h3>
                    <p>适合顺手补调料、纸巾等自由项。</p>
                  </div>
                </div>
                <div className="recipe-shopping-custom-row">
                  <div className="recipe-shopping-combobox">
                    <div className="recipe-shopping-combobox-field">
                      <RecipeUiIcon name="search" />
                      <input
                        value={shoppingCustomForm.title}
                        placeholder="搜索或输入食材名称"
                        onFocus={() => setIsShoppingIngredientPickerOpen(true)}
                        onChange={(event) => {
                          const nextTitle = event.target.value;
                          const matched = shoppingIngredientOptions.find((item) => item.name === nextTitle);
                          setShoppingCustomForm({
                            ...shoppingCustomForm,
                            title: nextTitle,
                            unit: matched?.unit ?? shoppingCustomForm.unit,
                          });
                          setIsShoppingIngredientPickerOpen(true);
                        }}
                      />
                    </div>
                    {isShoppingIngredientPickerOpen && visibleShoppingIngredientOptions.length > 0 && (
                      <div className="recipe-shopping-combobox-menu">
                        {visibleShoppingIngredientOptions.map((option) => (
                          <button key={option.id} type="button" onClick={() => selectShoppingIngredientOption(option)}>
                            <img src={option.imageUrl} alt="" />
                            <span>
                              <strong>{option.name}</strong>
                              <small>{option.category || '食材'} · 默认 {option.unit}</small>
                            </span>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                  <div className="recipe-shopping-custom-quantity">
                    <button type="button" onClick={() => adjustCustomShoppingQuantity(-1)} aria-label="自定义食材数量减一">
                      <RecipeUiIcon name="minus" />
                    </button>
                    <input
                      value={shoppingCustomForm.quantity}
                      inputMode="decimal"
                      placeholder="数量"
                      onChange={(event) => setShoppingCustomForm({ ...shoppingCustomForm, quantity: event.target.value })}
                    />
                    <button type="button" onClick={() => adjustCustomShoppingQuantity(1)} aria-label="自定义食材数量加一">
                      <RecipeUiIcon name="plus" />
                    </button>
                  </div>
                  <div className="recipe-shopping-select-shell">
                    <select
                      value={shoppingCustomForm.unit}
                      onChange={(event) => setShoppingCustomForm({ ...shoppingCustomForm, unit: event.target.value })}
                      aria-label="自定义食材单位"
                    >
                      {[shoppingCustomForm.unit, ...SHOPPING_UNIT_OPTIONS].filter((unit, index, list) => unit && list.indexOf(unit) === index).map((unit) => (
                        <option key={unit} value={unit}>{unit}</option>
                      ))}
                    </select>
                    <RecipeUiIcon name="chevronDown" />
                  </div>
                  <button className="recipe-shopping-add-button" type="button" onClick={addCustomShoppingDraft}>加入</button>
                </div>
              </section>

              <div className="recipe-shopping-footer-bar">
                <div className="recipe-shopping-footer-summary">
                  <span><RecipeUiIcon name="clipboard" /></span>
                  <p>已选择 <strong>{buildShoppingPayloadsFromDrafts(shoppingDrafts).length} 项</strong>，将加入采购清单</p>
                </div>
                <div className="workspace-overlay-actions">
                  <ActionButton tone="secondary" type="button" onClick={closeShoppingDialog}>
                    取消
                  </ActionButton>
                  <ActionButton tone="primary" type="button" onClick={() => void submitShoppingDrafts()} disabled={props.isCreatingShopping || shoppingDrafts.length === 0}>
                    {props.isCreatingShopping ? '加入中...' : '确认加入清单'}
                  </ActionButton>
                </div>
              </div>
            </div>
          </WorkspaceModal>
        </div>
      )}

      {isCookFinishOpen && activeCookCard && cookSession && (
        <div className="workspace-overlay-root">
          <div className="workspace-overlay-backdrop" onClick={() => setIsCookFinishOpen(false)} />
          <WorkspaceModal
            title={`完成烹饪：${activeCookCard.recipe.title}`}
            description={cookPreview?.shortages.length ? '还有缺料，先加入采购或补齐库存后再确认。' : '确认本次份量、餐次和库存扣减。'}
            eyebrow="完成确认"
            onClose={() => setIsCookFinishOpen(false)}
            className="recipe-cook-finish-modal"
          >
            <form className="recipe-cook-finish-form" onSubmit={submitCookRecipe}>
              <div className="recipe-cook-finish-preview">
                {isCookPreviewLoading ? (
                  <p className="subtle">正在计算扣减预览...</p>
                ) : cookPreviewError ? (
                  <article className="alert-card warning">
                    <h3>预览暂不可用</h3>
                    <p>{cookPreviewError}</p>
                  </article>
                ) : cookPreview?.shortages.length ? (
                  cookPreview.shortages.map((item) => (
                    <article key={`${item.ingredient_name}-${item.unit}`} className="alert-card warning">
                      <h3>{item.ingredient_name}</h3>
                      <p>还缺 {formatCookQuantity(item.missing_quantity)}{item.unit}，暂不能确认扣库存。</p>
                    </article>
                  ))
                ) : cookPreview?.preview_items.length ? (
                  cookPreview.preview_items.map((item) => (
                    <article key={`${item.ingredient_id}-${item.unit}`} className="recipe-cook-preview-row">
                      <div className="recipe-cook-preview-row-head">
                        <h3>{item.ingredient_name}</h3>
                        <span>{formatCookQuantity(item.requested_quantity)}{item.unit}</span>
                      </div>
                      <div className="recipe-cook-preview-batches">
                        {item.batches.map((batch) => (
                          <p key={batch.inventory_item_id}>
                            <strong>{formatCookQuantity(batch.quantity)}{batch.unit}</strong>
                            <span>{batch.storage_location}</span>
                            <span>{batch.expiry_date ? `到期 ${formatDate(batch.expiry_date)}` : '未设到期'}</span>
                          </p>
                        ))}
                      </div>
                    </article>
                  ))
                ) : (
                  <p className="subtle">当前菜谱没有需要扣减的库存项。</p>
                )}
              </div>
              <div className="form-grid compact-grid">
                <label>
                  <span>本次份量</span>
                  <input className="text-input" type="number" min="1" step="0.5" value={cookSession.servings} onChange={(event) => updateCookSession({ servings: event.target.value })} />
                </label>
                <label>
                  <span>日期</span>
                  <input className="text-input" type="date" value={cookSession.date} onChange={(event) => updateCookSession({ date: event.target.value })} />
                </label>
                <label>
                  <span>餐次</span>
                  <select className="text-input" value={cookSession.mealType} onChange={(event) => updateCookSession({ mealType: event.target.value as MealType })}>
                    {MEAL_TYPE_OPTIONS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
                  </select>
                </label>
                <label>
                  <span>满意度</span>
                  <select className="text-input" value={cookSession.rating} onChange={(event) => updateCookSession({ rating: event.target.value })}>
                    <option value="">不评分</option>
                    <option value="5">5 分</option>
                    <option value="4">4 分</option>
                    <option value="3">3 分</option>
                    <option value="2">2 分</option>
                    <option value="1">1 分</option>
                  </select>
                </label>
              </div>
              <label className="checkbox-row checkbox-card">
                <input type="checkbox" checked={cookSession.createMealLog} onChange={(event) => updateCookSession({ createMealLog: event.target.checked })} />
                <span>同步生成餐食记录</span>
              </label>
              <label>
                <span>做法调整 / 变体</span>
                <textarea className="text-input" rows={2} value={cookSession.adjustments} placeholder="例如：少放一勺油、番茄多炒 2 分钟出汁" onChange={(event) => updateCookSession({ adjustments: event.target.value })} />
              </label>
              <label>
                <span>本次结果</span>
                <textarea className="text-input" rows={2} value={cookSession.resultNote} placeholder="例如：孩子很喜欢，下次可以再少一点盐" onChange={(event) => updateCookSession({ resultNote: event.target.value })} />
              </label>
              <div className="workspace-overlay-actions">
                <ActionButton tone="secondary" type="button" onClick={() => setIsCookFinishOpen(false)}>继续做</ActionButton>
                <ActionButton tone="primary" type="submit" disabled={cookSubmitDisabled}>
                  {props.isCookingRecipe ? '处理中...' : '确认扣库存'}
                </ActionButton>
              </div>
            </form>
          </WorkspaceModal>
        </div>
      )}

      {isSceneManagerOpen && (
        <div className="workspace-overlay-root">
          <div className="workspace-overlay-backdrop" onClick={() => setIsSceneManagerOpen(false)} />
          <WorkspaceModal
            title="场景管理"
            description="新增常用场景，或隐藏不想展示的场景入口。"
            eyebrow="菜谱场景"
            onClose={() => setIsSceneManagerOpen(false)}
            className="recipe-scene-modal"
          >
            <div className="recipe-scene-manager">
              <div className="recipe-scene-manager-toolbar">
                <ActionButton tone="primary" type="button" onClick={openCreateSceneForm}>
                  新增场景
                </ActionButton>
              </div>
              {sceneFormMode && (
                <form className="recipe-scene-form" onSubmit={submitSceneDraft}>
                  <div className="recipe-scene-form-head">
                    <strong>{sceneFormMode === 'edit' ? `编辑场景：${editingSceneName}` : '新增场景'}</strong>
                    <button type="button" onClick={closeSceneForm}>
                      收起
                    </button>
                  </div>
                  <div className="recipe-scene-form-left">
                    <label className="recipe-scene-input-field">
                      <span><RecipeUiIcon name="filter" /></span>
                      <input
                        className="text-input"
                        value={sceneDraft.name}
                        placeholder="场景名称，例如：减脂晚餐"
                        onChange={(event) => setSceneDraft({ ...sceneDraft, name: event.target.value })}
                      />
                    </label>
                    <label className="recipe-scene-input-field">
                      <span><RecipeUiIcon name="view" /></span>
                      <input
                        className="text-input"
                        value={sceneDraft.description}
                        placeholder="信息说明，例如：清爽高蛋白"
                        onChange={(event) => setSceneDraft({ ...sceneDraft, description: event.target.value })}
                      />
                    </label>
                    <label className="recipe-scene-input-field">
                      <span><RecipeUiIcon name="sparkle" /></span>
                      <input
                        className="text-input"
                        value={sceneDraft.imagePrompt}
                        placeholder="图片描述，例如：清爽的减脂晚餐餐盘"
                        onChange={(event) => setSceneDraft({ ...sceneDraft, imagePrompt: event.target.value })}
                      />
                    </label>
                    <ActionButton tone="primary" type="submit">
                      <span aria-hidden="true">+</span>
                      {sceneFormMode === 'edit' ? '保存场景' : '添加场景'}
                    </ActionButton>
                  </div>
                  <div className="recipe-scene-image-panel">
                    <button
                      className={sceneDraft.imageAssetUrl ? 'recipe-scene-generate-card has-image' : 'recipe-scene-generate-card'}
                      type="button"
                      disabled={sceneImageState.isGenerating || !sceneDraft.name.trim()}
                      onClick={() => void generateSceneImage(sceneDraft, { draft: true })}
                    >
                      {sceneDraft.imageAssetUrl ? (
                        <img src={resolveAssetUrl(sceneDraft.imageAssetUrl)} alt={sceneDraft.name || '场景图片'} />
                      ) : (
                        <>
                          <span className="recipe-scene-generate-visual"><RecipeUiIcon name="sparkle" /></span>
                          <strong>{sceneImageState.isGenerating && generatingSceneName === sceneDraft.name.trim() ? '生成中...' : 'AI 生成图片'}</strong>
                          <small>根据描述生成场景配图</small>
                        </>
                      )}
                    </button>
                    {sceneDraft.imageAssetUrl && (
                      <button className="recipe-scene-remove-image" type="button" onClick={() => setSceneDraft({ ...sceneDraft, imageAssetId: undefined, imageAssetUrl: undefined })}>
                        移除图片
                      </button>
                    )}
                    {!sceneDraft.name.trim() && (
                      <small className="recipe-scene-image-hint">填写场景名称后可生成图片</small>
                    )}
                    {sceneImageState.errorMessage && (
                      <p className="image-composer-error recipe-scene-error">{sceneImageState.errorMessage}</p>
                    )}
                  </div>
                </form>
              )}

              <div className="recipe-scene-list">
                {categoryCards.length > 0 ? (
                  categoryCards.map((scene) => (
                    <article key={scene.name} className="recipe-scene-row">
                      <div className="recipe-scene-row-thumb">
                        {scene.imageAssetUrl ? <img src={resolveAssetUrl(scene.imageAssetUrl)} alt="" /> : <RecipeUiIcon name="sparkle" />}
                      </div>
                      <div>
                        <strong>{scene.name}</strong>
                        <span>{scene.description || `${scene.count} 道菜谱`}</span>
                      </div>
                      <div className="recipe-scene-row-actions">
                        <button type="button" onClick={() => openEditSceneForm(scene)}>
                          编辑
                        </button>
                        <button type="button" onClick={() => void deleteManagedScene(scene.name)} disabled={props.isUpdatingScene}>删除</button>
                      </div>
                    </article>
                  ))
                ) : (
                  <p className="subtle">暂无可管理场景。</p>
                )}
                {managedScenes.filter((scene) => scene.hidden).map((scene) => (
                  <article key={scene.name} className="recipe-scene-row muted">
                    <div className="recipe-scene-row-thumb"><RecipeUiIcon name="leaf" /></div>
                    <div>
                      <strong>{scene.name}</strong>
                      <span>已隐藏</span>
                    </div>
                    <button type="button" onClick={() => void restoreManagedScene(scene.name)} disabled={props.isUpdatingScene}>恢复</button>
                  </article>
                ))}
              </div>
            </div>
          </WorkspaceModal>
        </div>
      )}

    </div>
  );
}
