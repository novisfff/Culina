import { useMemo, useState, type FormEvent, type PointerEvent } from 'react';
import { API_BASE_URL } from '../../api/client';
import type {
  Food,
  FoodPlanItem,
  FoodPayload,
  FoodRecommendationItem,
  FoodRecommendations,
  FoodScene,
  FoodType,
  ImageInputValue,
  Ingredient,
  InventoryItem,
  MealLog,
  MealType,
  Recipe,
} from '../../api/types';
import {
  ActionButton,
  Badge,
  EmptyState,
  ImageComposer,
  PageHeader,
  SegmentedTabs,
  WorkspaceDrawer,
  WorkspaceModal,
  WorkspaceSubpageHeader,
  WorkspaceSubpageShell,
  WorkspaceToolbar,
} from '../ui-kit';
import { FoodPlanDetailModal, type FoodPlanDetailFormState } from './FoodPlanDetailModal';
import { FOOD_TYPE_LABELS, MEAL_TYPE_LABELS, emptyImages, formatDate, getFoodCover, splitTags, todayKey } from '../../lib/ui';
import {
  type AiRenderPayload,
  generateImageFromText,
  getMediaIds,
  regenerateImageFromReference,
  uploadReferenceAndGenerateImage,
} from '../../lib/aiImages';
import { buildRecipeCards, type RecipeCardViewModel } from '../recipes/workspaceModel';

type FoodWorkspaceView = 'list' | 'create' | 'edit';
type FoodWorkspaceLens = 'all' | 'today' | 'selfMade' | 'outside' | 'ready' | 'expiring' | 'favorite' | 'needsInfo';
export type FoodGovernanceIssue = 'image' | 'meal' | 'note' | 'source' | 'stock';
type NormalizedFoodType = Exclude<FoodType, 'packaged'>;
type FoodIconName =
  | 'bell'
  | 'bookOpen'
  | 'bowl'
  | 'calendar'
  | 'cloche'
  | 'heart'
  | 'home'
  | 'clock'
  | 'plus'
  | 'receipt'
  | 'search'
  | 'list'
  | 'logo'
  | 'star'
  | 'refresh'
  | 'arrowLeft'
  | 'arrowRight'
  | 'check'
  | 'clipboard'
  | 'moon'
  | 'save'
  | 'sun'
  | 'tag'
  | 'trash';

export type TodayFoodRecommendation = {
  food: Food;
  mealType: MealType;
  score: number;
  reasons: string[];
};

export type FoodRelationFact = {
  label: string;
  value: string;
};

export type FoodRelationViewModel = {
  linkedRecipeCard: RecipeCardViewModel | null;
  usage: {
    count: number;
    last: string | null;
  };
  lastMealLog: MealLog | null;
  relationFacts: FoodRelationFact[];
  shortagePreview: string[];
  summary: string;
  detail: string;
};

type FoodSceneFormMode = 'create' | 'edit' | null;

type ManagedFoodScene = {
  id?: string;
  name: string;
  description: string;
  imagePrompt: string;
  imageAssetId?: string;
  imageAssetUrl?: string;
  hidden?: boolean;
  custom?: boolean;
};

export type FoodFormState = {
  name: string;
  type: FoodType;
  category: string;
  sceneTags: string;
  suitableMealTypes: MealType[];
  sourceName: string;
  purchaseSource: string;
  scene: string;
  notes: string;
  routineNote: string;
  price: string;
  rating: string;
  repurchase: 'unknown' | 'yes' | 'no';
  expiryDate: string;
  stockQuantity: string;
  stockUnit: string;
  favorite: boolean;
  recipeId: string;
  images: ImageInputValue;
};

type ImageGenerationUiState = {
  isGenerating: boolean;
  errorMessage: string | null;
};

type Props = {
  foods: Food[];
  recipes: Recipe[];
  ingredients: Ingredient[];
  inventoryItems: InventoryItem[];
  mealLogs: MealLog[];
  foodRecommendations?: FoodRecommendations | null;
  foodScenes: FoodScene[];
  foodPlanItems: FoodPlanItem[];
  foodPlanWeekRange: { start: string; end: string };
  createFood: (payload: FoodPayload) => Promise<Food>;
  updateFood: (foodId: string, payload: FoodPayload) => Promise<Food>;
  updateFoodFavorite: (foodId: string, favorite: boolean) => Promise<Food>;
  quickAddMeal: (payload: { food_id: string; date: string; meal_type: MealType; servings: number; note: string; food_plan_item_id?: string }) => Promise<MealLog>;
  createFoodPlanItem: (payload: { food_id: string; plan_date: string; meal_type: MealType; note: string }) => Promise<FoodPlanItem>;
  updateFoodPlanItem: (itemId: string, payload: { food_id?: string; plan_date?: string; meal_type?: MealType; note?: string; status?: 'planned' | 'cooked' | 'skipped' }) => Promise<FoodPlanItem>;
  deleteFoodPlanItem: (itemId: string) => Promise<void>;
  createFoodScene: (payload: {
    name: string;
    description: string;
    image_prompt: string;
    image_asset_id?: string;
    hidden: boolean;
    custom: boolean;
    sort_order: number;
  }) => Promise<FoodScene>;
  updateFoodScene: (
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
  ) => Promise<FoodScene>;
  deleteFoodScene: (sceneId: string) => Promise<void>;
  onOpenRecipes: () => void;
  onStartRecipe: (recipeId: string, foodPlanItemId?: string) => void;
  onOpenLogs: () => void;
  onFoodPlanPreviousWeek: () => void;
  onFoodPlanCurrentWeek: () => void;
  onFoodPlanNextWeek: () => void;
  isSavingFood?: boolean;
  isUpdatingFavorite?: boolean;
  isQuickAdding?: boolean;
  isUpdatingPlan?: boolean;
  isUpdatingScene?: boolean;
};

type RecommendationCardViewModel = {
  food: Food;
  mealType: MealType;
  score: number;
  reasons: string[];
  primaryAction: 'cook_recipe' | 'quick_add_meal' | 'review_food';
  recipeAvailability?: FoodRecommendationItem['recipe_availability'];
};

export const FOOD_TYPE_OPTIONS: Array<{ value: FoodType; label: string }> = [
  { value: 'selfMade', label: '家常菜' },
  { value: 'takeout', label: '外卖' },
  { value: 'diningOut', label: '外食' },
  { value: 'readyMade', label: '成品' },
  { value: 'instant', label: '速食' },
];

export const FOOD_CREATE_TYPE_OPTIONS = FOOD_TYPE_OPTIONS.filter((item) => item.value !== 'selfMade');

const FOOD_CREATE_TYPE_DETAILS: Partial<Record<FoodType, { icon: FoodIconName; description: string }>> = {
  takeout: { icon: 'receipt', description: '常点店铺' },
  diningOut: { icon: 'tag', description: '餐厅记录' },
  readyMade: { icon: 'bowl', description: '即开即吃' },
  instant: { icon: 'clock', description: '备用速食' },
};

const MEAL_OPTIONS: Array<{ value: MealType; label: string }> = [
  { value: 'breakfast', label: '早餐' },
  { value: 'lunch', label: '午餐' },
  { value: 'dinner', label: '晚餐' },
  { value: 'snack', label: '加餐' },
];

function addFoodPlanDateDays(dateKey: string, days: number) {
  const [year, month, day] = dateKey.split('-').map(Number);
  const date = new Date(year, (month || 1) - 1, day || 1);
  date.setDate(date.getDate() + days);
  return date.toISOString().slice(0, 10);
}

function getFoodPlanDateParts(dateKey: string) {
  const [year, month, day] = dateKey.split('-').map(Number);
  const date = new Date(year, (month || 1) - 1, day || 1);
  return {
    day: String(day || 1),
    month: String(month || 1),
    weekday: new Intl.DateTimeFormat('zh-CN', { weekday: 'short' }).format(date),
  };
}

const FOOD_QUICK_VIEW_OPTIONS: Array<{ value: FoodWorkspaceLens; label: string }> = [
  { value: 'all', label: '全部' },
  { value: 'selfMade', label: '家常菜' },
  { value: 'outside', label: '外卖外食' },
  { value: 'ready', label: '成品速食' },
];

const FOOD_GOVERNANCE_ISSUE_OPTIONS: Array<{ value: FoodGovernanceIssue; label: string; description: string }> = [
  { value: 'image', label: '缺图片', description: '补一张主图，卡片和记录更容易识别。' },
  { value: 'meal', label: '缺餐别', description: '设置早餐、午餐、晚餐或加餐，才能参与今日推荐。' },
  { value: 'note', label: '缺备注', description: '补场景标签、常用备注或复吃说明。' },
  { value: 'source', label: '缺来源', description: '补店铺、餐厅、品牌或购买渠道。' },
  { value: 'stock', label: '缺库存/到期', description: '成品速食需要数量、单位和到期日期。' },
];

const FOOD_LENS_COPY: Record<FoodWorkspaceLens, { title: string; description: string; emptyTitle: string; emptyDescription: string }> = {
  all: {
    title: '全部食物',
    description: '完整浏览家里的食物资产，适合批量检查资料和复吃记录。',
    emptyTitle: '还没有食物',
    emptyDescription: '先新增一份外卖、成品或速食，家常菜会从菜谱自动沉淀。',
  },
  today: {
    title: '今晚吃什么',
    description: '优先显示适合午餐或晚餐的食物，用来快速安排今天这一餐。',
    emptyTitle: '还没有今晚可选',
    emptyDescription: '给食物补上午餐或晚餐餐别后，它们会出现在这里。',
  },
  selfMade: {
    title: '家常菜',
    description: '关注关联菜谱、复做次数和适合餐别，适合决定要不要自己做。',
    emptyTitle: '还没有家常菜',
    emptyDescription: '家常菜从菜谱同步而来，可以先去新增一份菜谱。',
  },
  outside: {
    title: '外卖外食',
    description: '关注店铺、价格、评分和复购意愿，适合决定要不要再吃一次。',
    emptyTitle: '还没有外卖外食',
    emptyDescription: '新增一份常点外卖或常去餐厅，之后就能快速复吃。',
  },
  ready: {
    title: '成品速食',
    description: '关注库存、到期和购买渠道，适合处理备用餐和临期食品。',
    emptyTitle: '还没有成品速食',
    emptyDescription: '新增常备成品或速食后，这里会帮助你看库存和到期。',
  },
  expiring: {
    title: '临期',
    description: '只看需要尽快处理的成品和速食。',
    emptyTitle: '没有临期食物',
    emptyDescription: '当前没有需要优先处理的成品或速食。',
  },
  favorite: {
    title: '收藏/常吃',
    description: '汇总收藏或复吃频率高的食物，适合低成本做决定。',
    emptyTitle: '还没有常吃食物',
    emptyDescription: '收藏食物或多记录几次，它们就会进入常吃视角。',
  },
  needsInfo: {
    title: '待完善',
    description: '集中补齐缺图片、缺来源、缺餐别或缺备注的食物。',
    emptyTitle: '资料都比较完整',
    emptyDescription: '当前没有明显缺少决策信息的食物。',
  },
};

const IDLE_IMAGE_GENERATION_STATE: ImageGenerationUiState = { isGenerating: false, errorMessage: null };

function resolveFoodAssetUrl(url: string) {
  if (url.startsWith('http://') || url.startsWith('https://') || url.startsWith('data:')) {
    return url;
  }
  return `${API_BASE_URL}${url}`;
}

function FoodRatingInput(props: { value: string; onChange: (value: string) => void }) {
  const rating = normalizeNumber(props.value) ?? 0;
  const display = rating > 0 ? `${rating.toFixed(1).replace(/\.0$/, '')} 分` : '未评分';
  const stars = Array.from({ length: 5 }, (_, index) => <span key={index}>★</span>);
  function updateRatingFromClientX(element: HTMLDivElement, clientX: number) {
    const rect = element.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    const nextRating = Math.max(0.5, Math.round(ratio * 10) / 2);
    props.onChange(String(nextRating));
  }
  function updateRatingFromPointer(event: PointerEvent<HTMLDivElement>) {
    updateRatingFromClientX(event.currentTarget, event.clientX);
  }
  return (
    <div className="food-rating-input">
      <div
        className="food-rating-stars"
        role="slider"
        aria-label="评分"
        aria-valuemin={0}
        aria-valuemax={5}
        aria-valuenow={rating}
        tabIndex={0}
        style={{ ['--rating-width' as string]: `${(rating / 5) * 100}%` }}
        onPointerDown={(event) => {
          event.preventDefault();
          event.stopPropagation();
          event.currentTarget.setPointerCapture(event.pointerId);
          updateRatingFromPointer(event);
        }}
        onPointerMove={(event) => {
          if (event.buttons === 1) {
            event.preventDefault();
            event.stopPropagation();
            updateRatingFromPointer(event);
          }
        }}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
        }}
        onKeyDown={(event) => {
          if (event.key === 'ArrowRight' || event.key === 'ArrowUp') {
            event.preventDefault();
            props.onChange(String(Math.min(5, rating + 0.5 || 0.5)));
          }
          if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') {
            event.preventDefault();
            const nextRating = Math.max(0, rating - 0.5);
            props.onChange(nextRating > 0 ? String(nextRating) : '');
          }
        }}
      >
        <div className="food-rating-star-layer" aria-hidden="true">
          {stars}
        </div>
        <div className="food-rating-star-layer filled" aria-hidden="true">
          {stars}
        </div>
      </div>
      <strong>{display}</strong>
      {rating > 0 && (
        <button
          className="food-rating-clear"
          type="button"
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            props.onChange('');
          }}
        >
          清除
        </button>
      )}
    </div>
  );
}

function FoodUiIcon(props: { name: FoodIconName; className?: string }) {
  const common = {
    width: 20,
    height: 20,
    viewBox: '0 0 24 24',
    fill: 'none',
    xmlns: 'http://www.w3.org/2000/svg',
    'aria-hidden': true,
  };
  const strokeProps = {
    stroke: 'currentColor',
    strokeWidth: props.name === 'logo' ? 1.8 : 2,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
  };

  return (
    <svg {...common} className={props.className}>
      {props.name === 'bowl' && (
        <>
          <path {...strokeProps} d="M5 12h14a7 7 0 0 1-14 0Z" />
          <path {...strokeProps} d="M8 19h8" />
          <path {...strokeProps} d="M8 8c-.7-.8-.7-1.6 0-2.4" />
          <path {...strokeProps} d="M12 8c-.7-.8-.7-1.6 0-2.4" />
          <path {...strokeProps} d="M16 8c-.7-.8-.7-1.6 0-2.4" />
        </>
      )}
      {props.name === 'logo' && (
        <>
          <path {...strokeProps} d="M6 10h12" />
          <path {...strokeProps} d="M7 10v3a5 5 0 0 0 10 0v-3" />
          <path {...strokeProps} d="M17 11h1a2 2 0 0 1 0 4h-1" />
          <path {...strokeProps} d="M9 7V5" />
          <path {...strokeProps} d="M12 7V4" />
          <path {...strokeProps} d="M15 7V5" />
        </>
      )}
      {props.name === 'bookOpen' && (
        <>
          <path {...strokeProps} d="M4 5.5A2.5 2.5 0 0 1 6.5 3H11v17H6.5A2.5 2.5 0 0 0 4 22V5.5Z" />
          <path {...strokeProps} d="M20 5.5A2.5 2.5 0 0 0 17.5 3H13v17h4.5A2.5 2.5 0 0 1 20 22V5.5Z" />
        </>
      )}
      {props.name === 'bell' && (
        <>
          <path {...strokeProps} d="M6 9a6 6 0 0 1 12 0c0 7 3 6 3 8H3c0-2 3-1 3-8" />
          <path {...strokeProps} d="M10 20a2 2 0 0 0 4 0" />
        </>
      )}
      {props.name === 'calendar' && (
        <>
          <path {...strokeProps} d="M7 3v4" />
          <path {...strokeProps} d="M17 3v4" />
          <rect {...strokeProps} x="4" y="6" width="16" height="14" rx="2" />
          <path {...strokeProps} d="M8 11h8" />
        </>
      )}
      {props.name === 'cloche' && (
        <>
          <path {...strokeProps} d="M4 17h16" />
          <path {...strokeProps} d="M6 17a6 6 0 0 1 12 0" />
          <path {...strokeProps} d="M12 8V5" />
          <path {...strokeProps} d="M9.5 5h5" />
          <path {...strokeProps} d="M3 20h18" />
        </>
      )}
      {props.name === 'heart' && (
        <path {...strokeProps} d="M20.4 5.6a5 5 0 0 0-7.1 0L12 6.9l-1.3-1.3a5 5 0 0 0-7.1 7.1L12 21l8.4-8.3a5 5 0 0 0 0-7.1Z" />
      )}
      {props.name === 'home' && (
        <>
          <path {...strokeProps} d="m3 11 9-8 9 8" />
          <path {...strokeProps} d="M5 10v10h14V10" />
          <path {...strokeProps} d="M10 20v-6h4v6" />
        </>
      )}
      {props.name === 'clock' && (
        <>
          <circle {...strokeProps} cx="12" cy="12" r="9" />
          <path {...strokeProps} d="M12 7v5l3.5 2" />
        </>
      )}
      {props.name === 'plus' && (
        <>
          <circle {...strokeProps} cx="12" cy="12" r="9" />
          <path {...strokeProps} d="M12 8v8M8 12h8" />
        </>
      )}
      {props.name === 'receipt' && (
        <>
          <path {...strokeProps} d="M6 3h12v18l-3-2-3 2-3-2-3 2V3Z" />
          <path {...strokeProps} d="M9 8h6M9 12h3" />
          <path {...strokeProps} d="M15.5 13.5 17 15l3-3" />
        </>
      )}
      {props.name === 'search' && (
        <>
          <circle {...strokeProps} cx="11" cy="11" r="6.5" />
          <path {...strokeProps} d="m16 16 4 4" />
        </>
      )}
      {props.name === 'list' && (
        <>
          <path {...strokeProps} d="M9 7h10" />
          <path {...strokeProps} d="M9 12h10" />
          <path {...strokeProps} d="M9 17h10" />
          <path {...strokeProps} d="M5 7h.01" />
          <path {...strokeProps} d="M5 7h.01" />
          <path {...strokeProps} d="M5 12h.01" />
          <path {...strokeProps} d="M5 17h.01" />
        </>
      )}
      {props.name === 'star' && (
        <path {...strokeProps} d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2-5.6-3-5.6 3 1.1-6.2L3 9.6l6.2-.9L12 3Z" />
      )}
      {props.name === 'refresh' && (
        <>
          <path {...strokeProps} d="M20 11a8 8 0 0 0-14.4-4.7L4 8" />
          <path {...strokeProps} d="M4 4v4h4" />
          <path {...strokeProps} d="M4 13a8 8 0 0 0 14.4 4.7L20 16" />
          <path {...strokeProps} d="M20 20v-4h-4" />
        </>
      )}
      {props.name === 'arrowLeft' && (
        <>
          <path {...strokeProps} d="M19 12H5" />
          <path {...strokeProps} d="m12 19-7-7 7-7" />
        </>
      )}
      {props.name === 'arrowRight' && (
        <>
          <path {...strokeProps} d="M5 12h14" />
          <path {...strokeProps} d="m12 5 7 7-7 7" />
        </>
      )}
      {props.name === 'check' && <path {...strokeProps} d="m5 12 4 4L19 6" />}
      {props.name === 'clipboard' && (
        <>
          <path {...strokeProps} d="M9 4h6l1 2h2a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h2l1-2Z" />
          <path {...strokeProps} d="M9 4h6v4H9z" />
          <path {...strokeProps} d="M9 13h6M9 17h4" />
        </>
      )}
      {props.name === 'moon' && <path {...strokeProps} d="M20 14.5A7.5 7.5 0 0 1 9.5 4 8 8 0 1 0 20 14.5Z" />}
      {props.name === 'save' && (
        <>
          <path {...strokeProps} d="M5 4h12l2 2v14H5V4Z" />
          <path {...strokeProps} d="M8 4v6h8V4" />
          <path {...strokeProps} d="M8 20v-6h8v6" />
        </>
      )}
      {props.name === 'sun' && (
        <>
          <circle {...strokeProps} cx="12" cy="12" r="4" />
          <path {...strokeProps} d="M12 2v2M12 20v2M4.93 4.93l1.42 1.42M17.65 17.65l1.42 1.42M2 12h2M20 12h2M4.93 19.07l1.42-1.42M17.65 6.35l1.42-1.42" />
        </>
      )}
      {props.name === 'tag' && (
        <>
          <path {...strokeProps} d="M20 13.5 13.5 20 4 10.5V4h6.5L20 13.5Z" />
          <circle {...strokeProps} cx="8.5" cy="8.5" r="1" />
        </>
      )}
      {props.name === 'trash' && (
        <>
          <path {...strokeProps} d="M4 7h16" />
          <path {...strokeProps} d="M10 11v6M14 11v6" />
          <path {...strokeProps} d="M6 7l1 14h10l1-14" />
          <path {...strokeProps} d="M9 7V4h6v3" />
        </>
      )}
    </svg>
  );
}

function resolveImageGenerationErrorMessage(reason: unknown, fallback: string) {
  if (reason instanceof Error && reason.message.trim()) {
    return reason.message;
  }
  return fallback;
}

function extractReferenceAsset(reason: unknown): ImageInputValue['referenceAsset'] {
  if (reason && typeof reason === 'object' && 'referenceAsset' in reason) {
    return (reason as { referenceAsset?: ImageInputValue['referenceAsset'] }).referenceAsset;
  }
  return undefined;
}

function makeBlankFoodForm(type: FoodType = 'takeout'): FoodFormState {
  return {
    name: '',
    type,
    category: '',
    sceneTags: '',
    suitableMealTypes: ['lunch', 'dinner'],
    sourceName: '',
    purchaseSource: '',
    scene: '',
    notes: '',
    routineNote: '',
    price: '',
    rating: '',
    repurchase: 'unknown',
    expiryDate: '',
    stockQuantity: '',
    stockUnit: '',
    favorite: false,
    recipeId: '',
    images: emptyImages(),
  };
}

function foodToForm(food: Food): FoodFormState {
  const sceneTags = food.scene_tags ?? [];
  return {
    name: food.name,
    type: food.type === 'packaged' ? 'readyMade' : food.type,
    category: food.category,
    sceneTags: (sceneTags.length > 0 ? sceneTags : [...food.flavor_tags, food.scene].filter(Boolean)).join('、'),
    suitableMealTypes: food.suitable_meal_types.length > 0 ? food.suitable_meal_types : ['lunch', 'dinner'],
    sourceName: food.source_name,
    purchaseSource: food.purchase_source,
    scene: food.scene,
    notes: food.notes,
    routineNote: food.routine_note,
    price: food.price == null ? '' : String(food.price),
    rating: food.rating == null ? '' : String(food.rating),
    repurchase: food.repurchase == null ? 'unknown' : food.repurchase ? 'yes' : 'no',
    expiryDate: food.expiry_date ?? '',
    stockQuantity: food.stock_quantity == null ? '' : String(food.stock_quantity),
    stockUnit: food.stock_unit,
    favorite: food.favorite,
    recipeId: food.recipe_id ?? '',
    images: emptyImages(),
  };
}

function getFoodImagePayload(form: FoodFormState, recipes: Recipe[]): AiRenderPayload {
  const linkedRecipe = recipes.find((recipe) => recipe.id === form.recipeId);
  return {
    entity_type: 'food',
    title: form.name.trim() || linkedRecipe?.title || form.sourceName.trim() || '家庭食物',
    category: form.category.trim(),
    notes: [form.notes.trim(), form.routineNote.trim()].filter(Boolean).join('；'),
    tags: splitTags(form.sceneTags),
    scene: splitTags(form.sceneTags).join(' / ') || form.scene.trim(),
    ingredient_names: linkedRecipe?.ingredient_items.map((item) => item.ingredient_name).filter(Boolean) ?? [],
  };
}

function buildFoodSceneImagePayload(scene: Pick<ManagedFoodScene, 'name' | 'description' | 'imagePrompt'>): AiRenderPayload {
  const title = scene.name.trim() || '家庭食物场景';
  const prompt = scene.imagePrompt.trim();
  const description = scene.description.trim();
  return {
    entity_type: 'food_scene',
    title,
    category: '食物场景',
    scene: title,
    tags: [title, ...splitTags(description)].filter(Boolean),
    notes: [
      prompt ? `用户画面描述：${prompt}` : '',
      description ? `场景说明：${description}` : '',
      '这是食物库场景入口封面，重点表达家庭饮食场景和食物气质，不生成海报文字，不生成品牌包装。',
      '画面保持 Culina 的半写实家庭厨房静物摄影风格，浅色、通透、温暖，有自然食物或厨房环境细节。',
    ]
      .filter(Boolean)
      .join('\n'),
  };
}

function blankFoodSceneDraft(name = ''): ManagedFoodScene {
  return { name, description: '', imagePrompt: '', custom: true, hidden: false };
}

function getDaysUntil(dateValue?: string | null) {
  if (!dateValue) return null;
  const target = new Date(`${dateValue}T00:00:00`).getTime();
  const today = new Date(`${todayKey()}T00:00:00`).getTime();
  return Math.round((target - today) / 86_400_000);
}

function getDaysSince(dateValue: string, todayValue = todayKey()) {
  const target = new Date(`${dateValue}T00:00:00`).getTime();
  const today = new Date(`${todayValue}T00:00:00`).getTime();
  return Math.round((today - target) / 86_400_000);
}

export function getSuggestedMealTypeForHour(hour = new Date().getHours()): MealType {
  if (hour < 10) return 'breakfast';
  if (hour < 15) return 'lunch';
  if (hour < 22) return 'dinner';
  return 'snack';
}

function describeExpiry(food: Food) {
  const days = getDaysUntil(food.expiry_date);
  if (days == null) return null;
  if (days < 0) return `已过期 ${Math.abs(days)} 天`;
  if (days === 0) return '今天到期';
  if (days <= 7) return `${days} 天后到期`;
  return `${formatDate(food.expiry_date ?? '')} 到期`;
}

function normalizeFoodType(food: Food): NormalizedFoodType {
  return food.type === 'packaged' ? 'readyMade' : food.type;
}

function normalizeFormFoodType(foodType: FoodType): NormalizedFoodType {
  return foodType === 'packaged' ? 'readyMade' : foodType;
}

function isReadyLikeFood(food: Food) {
  const normalizedType = normalizeFoodType(food);
  return normalizedType === 'readyMade' || normalizedType === 'instant';
}

function isReadyLikeType(foodType: FoodType) {
  const normalizedType = normalizeFormFoodType(foodType);
  return normalizedType === 'readyMade' || normalizedType === 'instant';
}

function isOutsideFood(food: Food) {
  const normalizedType = normalizeFoodType(food);
  return normalizedType === 'takeout' || normalizedType === 'diningOut';
}

function isOutsideType(foodType: FoodType) {
  const normalizedType = normalizeFormFoodType(foodType);
  return normalizedType === 'takeout' || normalizedType === 'diningOut';
}

function getFoodSceneTags(food: Food) {
  return food.scene_tags ?? [];
}

function isFoodExpiring(food: Food) {
  return isReadyLikeFood(food) && (getDaysUntil(food.expiry_date) ?? 99) <= 7;
}

export function getFoodGovernanceIssues(food: Food, recipes: Recipe[] = []): FoodGovernanceIssue[] {
  const issues: FoodGovernanceIssue[] = [];
  if (!getFoodCover(food, recipes)) issues.push('image');
  if (food.suitable_meal_types.length === 0) issues.push('meal');
  if (!food.routine_note.trim() && !food.notes.trim() && !food.scene.trim() && getFoodSceneTags(food).length === 0) issues.push('note');
  if (normalizeFoodType(food) !== 'selfMade' && !food.source_name.trim() && !food.purchase_source.trim()) issues.push('source');
  if (isReadyLikeFood(food) && (food.stock_quantity == null || !food.stock_unit.trim() || !food.expiry_date)) issues.push('stock');
  return issues;
}

function getFoodGovernanceIssueLabels(food: Food, recipes: Recipe[] = []) {
  const labels = new Map(FOOD_GOVERNANCE_ISSUE_OPTIONS.map((item) => [item.value, item.label]));
  return getFoodGovernanceIssues(food, recipes).map((issue) => labels.get(issue) ?? issue);
}

function isFoodMissingDecisionInfo(food: Food, recipes: Recipe[] = []) {
  return getFoodGovernanceIssues(food, recipes).length > 0;
}

function getFoodStatus(food: Food, usage: ReturnType<typeof getMealUsage>, expiry: string | null, recipes: Recipe[] = []) {
  if (isFoodExpiring(food)) {
    return { label: expiry ?? '临期', detail: '优先处理', tone: 'warning' };
  }
  if (isFoodMissingDecisionInfo(food, recipes)) {
    return { label: '待完善', detail: '补资料', tone: 'attention' };
  }
  if (food.favorite || usage.count >= 2) {
    return { label: '常复吃', detail: usage.count > 0 ? `${usage.count} 次` : '已收藏', tone: 'good' };
  }
  if (usage.count === 0) {
    return { label: '新食物', detail: '待记录', tone: 'quiet' };
  }
  return { label: '已记录', detail: `${usage.count} 次`, tone: 'neutral' };
}

function getFoodPriority(food: Food, mealLogs: MealLog[], lensFilter: FoodWorkspaceLens, recipes: Recipe[] = []) {
  const usage = getMealUsage(food, mealLogs);
  const daysUntilExpiry = getDaysUntil(food.expiry_date);
  const expiryScore = isFoodExpiring(food) ? 500 - Math.max(daysUntilExpiry ?? 0, -30) : 0;
  const missingScore = isFoodMissingDecisionInfo(food, recipes) ? 120 : 0;
  const favoriteScore = food.favorite ? 80 : 0;
  const usageScore = usage.count * 12;
  const recentScore = usage.last ? Number(usage.last.replace(/-/g, '')) / 10_000_000 : 0;
  const lensBoost =
    lensFilter === 'expiring'
      ? expiryScore * 2
      : lensFilter === 'needsInfo'
        ? missingScore * 2
        : lensFilter === 'favorite'
          ? favoriteScore + usageScore
          : 0;
  return lensBoost + expiryScore + missingScore + favoriteScore + usageScore + recentScore;
}

function getMealUsage(food: Food, mealLogs: MealLog[]) {
  const logs = mealLogs.filter((log) => log.food_entries.some((entry) => entry.food_id === food.id));
  const sortedDates = logs.map((log) => log.date).sort((a, b) => b.localeCompare(a));
  return {
    count: logs.length,
    last: sortedDates[0] ?? null,
  };
}

function getDefaultMealType(food: Food): MealType {
  if (food.suitable_meal_types.includes('dinner')) return 'dinner';
  if (food.suitable_meal_types.includes('lunch')) return 'lunch';
  return food.suitable_meal_types[0] ?? 'dinner';
}

function getPrimaryFoodActionLabel(food: Food) {
  const normalizedType = normalizeFoodType(food);
  if (normalizedType === 'takeout' || normalizedType === 'diningOut') return '再吃一次';
  if (normalizedType === 'readyMade' || normalizedType === 'instant') return '记到今天';
  return '记到今天';
}

function getFoodCardPrimaryActionLabel(food: Food) {
  if (normalizeFoodType(food) === 'selfMade' && food.recipe_id) return '开始做';
  return getPrimaryFoodActionLabel(food);
}

function getRecommendationPrimaryActionLabel(item: RecommendationCardViewModel) {
  if (item.primaryAction === 'cook_recipe') return '开始做';
  if (item.primaryAction === 'quick_add_meal') return getPrimaryFoodActionLabel(item.food);
  return '查看详情';
}

function getSecondaryFoodActionLabel(food: Food) {
  if (normalizeFoodType(food) === 'selfMade') return '编辑档案';
  if (isReadyLikeFood(food)) return '更新库存';
  if (isOutsideFood(food)) return '编辑评价';
  return '编辑资料';
}

function getRepurchaseLabel(food: Food) {
  if (food.repurchase == null) return '未记录';
  return food.repurchase ? '愿意复购' : '暂不复购';
}

function getFoodFactRows(food: Food, usage: ReturnType<typeof getMealUsage>, expiry: string | null) {
  const normalizedType = normalizeFoodType(food);
  const mealText = food.suitable_meal_types.map((meal) => MEAL_TYPE_LABELS[meal]).join('、') || '未设置';
  if (normalizedType === 'selfMade') {
    return [
      { label: '菜谱', value: food.recipe_id ? '已关联' : '待关联' },
      { label: '复吃', value: usage.count > 0 ? `${usage.count} 次` : '还未记录' },
      { label: '餐别', value: mealText },
    ];
  }
  if (isOutsideFood(food)) {
    return [
      { label: normalizedType === 'takeout' ? '店铺' : '餐厅', value: food.source_name || food.purchase_source || '待补充' },
      { label: '价格', value: food.price == null ? '未记录' : `¥${food.price}` },
      { label: '复购', value: getRepurchaseLabel(food) },
    ];
  }
  return [
    { label: '库存', value: food.stock_quantity == null ? '未记录' : `${food.stock_quantity}${food.stock_unit}` },
    { label: '到期', value: expiry ?? '未记录' },
    { label: '渠道', value: food.purchase_source || food.source_name || '待补充' },
  ];
}

function getFoodMealHistory(food: Food, mealLogs: MealLog[]) {
  return mealLogs
    .filter((log) => log.food_entries.some((entry) => entry.food_id === food.id))
    .slice()
    .sort((a, b) => b.date.localeCompare(a.date) || b.created_at.localeCompare(a.created_at))
    .slice(0, 5)
    .map((log) => ({
      log,
      entry: log.food_entries.find((entry) => entry.food_id === food.id),
    }));
}

function getLastMealLogForFood(food: Food, mealLogs: MealLog[]) {
  return mealLogs
    .filter((log) => log.food_entries.some((entry) => entry.food_id === food.id))
    .slice()
    .sort((a, b) => b.date.localeCompare(a.date) || b.created_at.localeCompare(a.created_at))[0] ?? null;
}

function formatFoodStock(food: Food) {
  if (food.stock_quantity == null) return '未记录';
  return `${food.stock_quantity}${food.stock_unit || '份'}`;
}

function buildFoodRelationViewModelFromRecipeCards(
  food: Food,
  recipeCards: RecipeCardViewModel[],
  mealLogs: MealLog[]
): FoodRelationViewModel {
  const usage = getMealUsage(food, mealLogs);
  const lastMealLog = getLastMealLogForFood(food, mealLogs);
  const normalizedType = normalizeFoodType(food);
  const linkedRecipeCard = food.recipe_id ? recipeCards.find((card) => card.recipe.id === food.recipe_id) ?? null : null;
  const recordValue = usage.count > 0 ? `${usage.count} 次` : '还未记录';
  const lastValue = lastMealLog ? formatDate(lastMealLog.date) : '还没有';

  if (normalizedType === 'selfMade') {
    const shortagePreview = linkedRecipeCard?.shortages
      .slice(0, 3)
      .map((item) => `${item.ingredientName} ${item.missingQuantity}${item.unit}`) ?? [];
    return {
      linkedRecipeCard,
      usage,
      lastMealLog,
      relationFacts: [
        { label: '关联菜谱', value: linkedRecipeCard?.recipe.title ?? '未关联' },
        { label: '可做程度', value: linkedRecipeCard?.availabilityLabel ?? '无法判断' },
        { label: '餐食记录', value: recordValue },
        { label: '最近一次', value: lastValue },
      ],
      shortagePreview,
      summary: linkedRecipeCard ? `${linkedRecipeCard.recipe.title} · ${linkedRecipeCard.availabilityLabel}` : '未关联菜谱',
      detail: linkedRecipeCard
        ? shortagePreview.length > 0
          ? `缺 ${shortagePreview.join('、')}`
          : linkedRecipeCard.availabilityDetail
        : '关联菜谱后可以判断缺哪些食材。',
    };
  }

  if (isOutsideFood(food)) {
    return {
      linkedRecipeCard: null,
      usage,
      lastMealLog,
      relationFacts: [
        { label: '餐食记录', value: recordValue },
        { label: '最近一次', value: lastValue },
        { label: '复购评分', value: food.rating == null ? getRepurchaseLabel(food) : `${food.rating} 分 · ${getRepurchaseLabel(food)}` },
      ],
      shortagePreview: [],
      summary: `${recordValue}记录 · ${lastMealLog ? `上次 ${lastValue}` : '还没吃过'}`,
      detail: `${food.source_name || food.purchase_source || '未记录来源'} · ${getRepurchaseLabel(food)}`,
    };
  }

  const stockValue = formatFoodStock(food);
  return {
    linkedRecipeCard: null,
    usage,
    lastMealLog,
    relationFacts: [
      { label: '库存剩余', value: stockValue },
      { label: '到期', value: describeExpiry(food) ?? '未记录' },
      { label: '餐食记录', value: recordValue },
      { label: '最近一次', value: lastValue },
    ],
    shortagePreview: [],
    summary: `${stockValue}库存 · ${usage.count > 0 ? `吃过 ${usage.count} 次` : '还未记录'}`,
    detail: food.stock_quantity == null
      ? '库存未记录，补齐后会更适合做备用餐判断。'
      : `${food.purchase_source || food.source_name || '未记录来源'} · ${describeExpiry(food) ?? '未记录到期'}`,
  };
}

export function buildFoodRelationViewModel(
  food: Food,
  recipes: Recipe[],
  ingredients: Ingredient[],
  inventoryItems: InventoryItem[],
  mealLogs: MealLog[],
  foods: Food[]
): FoodRelationViewModel {
  return buildFoodRelationViewModelFromRecipeCards(
    food,
    buildRecipeCards(recipes, ingredients, inventoryItems, mealLogs, foods),
    mealLogs
  );
}

export function buildTodayFoodRecommendations(
  foods: Food[],
  mealLogs: MealLog[],
  options: { mealType?: MealType; today?: string; recipes?: Recipe[] } = {}
): TodayFoodRecommendation[] {
  const mealType = options.mealType ?? getSuggestedMealTypeForHour();
  const today = options.today ?? todayKey();
  const recipes = options.recipes ?? [];
  const foodsById = new Map(foods.map((food) => [food.id, food]));
  const recentTypeCounts = new Map<NormalizedFoodType, number>();

  mealLogs
    .filter((log) => {
      const daysSince = getDaysSince(log.date, today);
      return daysSince >= 0 && daysSince <= 3;
    })
    .forEach((log) => {
      log.food_entries.forEach((entry) => {
        const food = foodsById.get(entry.food_id);
        if (!food) return;
        const type = normalizeFoodType(food);
        recentTypeCounts.set(type, (recentTypeCounts.get(type) ?? 0) + 1);
      });
    });

  const dominantRecentType = Array.from(recentTypeCounts.entries()).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;

  const scored = foods
    .map((food) => {
      const usage = getMealUsage(food, mealLogs);
      const normalizedType = normalizeFoodType(food);
      const reasons: string[] = [];
      let score = 0;

      if (food.suitable_meal_types.includes(mealType)) {
        score += 130;
        reasons.push(`适合${MEAL_TYPE_LABELS[mealType]}`);
      } else if (food.suitable_meal_types.some((meal) => meal === 'lunch' || meal === 'dinner')) {
        score += 45;
        reasons.push('适合正餐');
      } else if (food.suitable_meal_types.length === 0) {
        score -= 70;
        reasons.push('未设置餐别');
      }

      const daysUntilExpiry = getDaysUntil(food.expiry_date);
      const expiring = isFoodExpiring(food);
      if (expiring) {
        const expiryScore = daysUntilExpiry == null ? 0 : daysUntilExpiry <= 0 ? 250 : daysUntilExpiry <= 3 ? 220 : 170;
        score += expiryScore;
        reasons.push(daysUntilExpiry == null || daysUntilExpiry > 0 ? '临期优先' : '今天需处理');
      }

      if (usage.last) {
        const daysSinceLast = getDaysSince(usage.last, today);
        const recentPenalty = daysSinceLast < 0 ? 0 : daysSinceLast <= 1 ? 160 : daysSinceLast <= 3 ? 90 : daysSinceLast <= 5 ? 45 : 0;
        if (recentPenalty > 0) {
          score -= expiring ? Math.round(recentPenalty * 0.45) : recentPenalty;
          reasons.push('最近吃过已降权');
        }
      }

      if (food.favorite) {
        score += 55;
        reasons.push('收藏');
      }
      if (usage.count >= 3) {
        score += 35;
        reasons.push('常复吃');
      } else if (usage.count > 0) {
        score += usage.count * 8;
      }
      if (food.rating != null) {
        score += food.rating >= 4 ? 55 : food.rating >= 3 ? 25 : -20;
        if (food.rating >= 4) reasons.push('高评分');
      }
      if (food.repurchase === true) {
        score += 45;
        reasons.push('愿意复购');
      }
      if (food.repurchase === false) {
        score -= 90;
        reasons.push('暂不复购');
      }
      if (dominantRecentType && normalizedType === dominantRecentType && !expiring) {
        score -= 35;
      } else if (dominantRecentType && normalizedType !== dominantRecentType) {
        score += 20;
        reasons.push('换个类型');
      }
      if (isFoodMissingDecisionInfo(food, recipes)) {
        score -= 25;
      }

      return {
        food,
        mealType: food.suitable_meal_types.includes(mealType) ? mealType : getDefaultMealType(food),
        score,
        reasons: (reasons.length > 0 ? reasons : ['可作为备选']).slice(0, 4),
      };
    })
    .sort((a, b) => b.score - a.score || b.food.updated_at.localeCompare(a.food.updated_at));

  const diverse: TodayFoodRecommendation[] = [];
  scored.forEach((item) => {
    if (diverse.length >= 3) return;
    const type = normalizeFoodType(item.food);
    if (diverse.length === 0 || !diverse.some((selected) => normalizeFoodType(selected.food) === type)) {
      diverse.push(item);
    }
  });

  scored.forEach((item) => {
    if (diverse.length >= 3) return;
    if (!diverse.some((selected) => selected.food.id === item.food.id)) {
      diverse.push(item);
    }
  });

  return diverse;
}

function getFoodAudienceText(food: Food, mealLogs: MealLog[]) {
  const history = getFoodMealHistory(food, mealLogs);
  const participantCount = Math.max(...history.map(({ log }) => log.participant_user_ids.length), 0);
  if (participantCount > 0) return `最近记录里最多 ${participantCount} 位成员一起吃`;
  if (food.suitable_meal_types.includes('snack')) return '适合临时加餐或小份分享';
  return '适合家庭成员共同安排';
}

function getFoodEditorProfile(foodType: FoodType) {
  const normalizedType = normalizeFormFoodType(foodType);
  if (normalizedType === 'selfMade') {
    return {
      title: '家常菜核心资料',
      description: '重点确认关联菜谱、适合餐别和家庭备注，做法本身在菜谱页维护。',
    };
  }
  if (normalizedType === 'takeout' || normalizedType === 'diningOut') {
    return {
      title: normalizedType === 'takeout' ? '外卖复吃判断' : '外食复吃判断',
      description: '把店铺/餐厅、价格、评分和复购意愿补齐，下次就能快速判断要不要再吃。',
    };
  }
  return {
    title: '成品与速食库存',
    description: '优先维护购买渠道、剩余数量和到期日期，这类食物会进入临期提醒。',
  };
}

function getFoodFormCompletionItems(form: FoodFormState, editingFood: Food | null, recipes: Recipe[] = []) {
  const hasImage = Boolean(form.images.generatedAsset || form.images.referenceAsset || (editingFood && getFoodCover(editingFood, recipes)));
  const items = [
    { label: form.type === 'selfMade' ? '关联菜谱' : '食物名称', done: form.type === 'selfMade' ? Boolean(form.recipeId) : Boolean(form.name.trim()) },
    { label: '适合餐别', done: form.suitableMealTypes.length > 0 },
    { label: '食物图片', done: hasImage },
    { label: '场景/备注', done: Boolean(form.routineNote.trim() || form.notes.trim() || splitTags(form.sceneTags).length > 0 || form.scene.trim()) },
  ];
  if (isOutsideType(form.type)) {
    items.push(
      { label: form.type === 'takeout' ? '店铺' : '餐厅', done: Boolean(form.sourceName.trim() || form.purchaseSource.trim()) },
      { label: '价格/评分', done: Boolean(form.price.trim() || form.rating.trim()) },
      { label: '复购意愿', done: form.repurchase !== 'unknown' }
    );
  }
  if (isReadyLikeType(form.type)) {
    items.push(
      { label: '购买渠道', done: Boolean(form.purchaseSource.trim() || form.sourceName.trim()) },
      { label: '剩余库存', done: Boolean(form.stockQuantity.trim() && form.stockUnit.trim()) },
      { label: '到期日期', done: Boolean(form.expiryDate) }
    );
  }
  return items;
}

function normalizeNumber(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

export function buildFoodPayloadFromForm(form: FoodFormState, recipes: Recipe[], mediaIds: string[]): FoodPayload {
  return {
    name: form.name.trim(),
    type: form.type,
    category: form.category.trim() || FOOD_TYPE_LABELS[form.type],
    flavor_tags: [],
    scene_tags: splitTags(form.sceneTags),
    suitable_meal_types: form.suitableMealTypes,
    source_name: form.sourceName.trim(),
    purchase_source: form.purchaseSource.trim() || form.sourceName.trim(),
    scene: form.scene.trim(),
    notes: form.notes.trim(),
    routine_note: form.routineNote.trim(),
    price: normalizeNumber(form.price),
    rating: normalizeNumber(form.rating),
    repurchase: form.repurchase === 'unknown' ? null : form.repurchase === 'yes',
    expiry_date: form.expiryDate || null,
    stock_quantity: normalizeNumber(form.stockQuantity),
    stock_unit: form.stockUnit.trim(),
    favorite: form.favorite,
    recipe_id: form.recipeId || null,
    media_ids: mediaIds,
  };
}

export function filterFoodWorkspaceItems(
  foods: Food[],
  search: string,
  typeFilter: 'all' | FoodType,
  mealFilter: 'all' | MealType,
  lensFilter: FoodWorkspaceLens = 'all',
  recipes: Recipe[] = []
) {
  const keyword = search.trim().toLowerCase();
  return foods.filter((food) => {
    const normalizedType = normalizeFoodType(food);
    const text = [food.name, food.category, food.source_name, food.purchase_source, food.scene, food.notes, food.routine_note, ...getFoodSceneTags(food)].join(' ').toLowerCase();
    const searchMatch = !keyword || text.includes(keyword);
    const typeMatch = typeFilter === 'all' || normalizedType === typeFilter;
    const mealMatch = mealFilter === 'all' || food.suitable_meal_types.includes(mealFilter);
    const lensMatch =
      lensFilter === 'all' ||
      (lensFilter === 'today' && food.suitable_meal_types.some((meal) => meal === 'lunch' || meal === 'dinner')) ||
      (lensFilter === 'selfMade' && normalizedType === 'selfMade') ||
      (lensFilter === 'outside' && isOutsideFood(food)) ||
      (lensFilter === 'ready' && isReadyLikeFood(food)) ||
      (lensFilter === 'expiring' && isFoodExpiring(food)) ||
      (lensFilter === 'favorite' && food.favorite) ||
      (lensFilter === 'needsInfo' && isFoodMissingDecisionInfo(food, recipes));
    return searchMatch && typeMatch && mealMatch && lensMatch;
  });
}

export function FoodWorkspace(props: Props) {
  const [view, setView] = useState<FoodWorkspaceView>('list');
  const [editingFood, setEditingFood] = useState<Food | null>(null);
  const [detailFoodId, setDetailFoodId] = useState<string | null>(null);
  const [form, setForm] = useState<FoodFormState>(() => makeBlankFoodForm());
  const [search, setSearch] = useState('');
  const [lensFilter, setLensFilter] = useState<FoodWorkspaceLens>('all');
  const [recommendationPage, setRecommendationPage] = useState(0);
  const [governanceIssueFilter, setGovernanceIssueFilter] = useState<'all' | FoodGovernanceIssue>('all');
  const [typeFilter, setTypeFilter] = useState<'all' | FoodType>('all');
  const [mealFilter, setMealFilter] = useState<'all' | MealType>('all');
  const [sceneFilter, setSceneFilter] = useState('all');
  const [isSceneManagerOpen, setIsSceneManagerOpen] = useState(false);
  const [sceneFormMode, setSceneFormMode] = useState<FoodSceneFormMode>(null);
  const [sceneDraft, setSceneDraft] = useState<ManagedFoodScene>({ name: '', description: '', imagePrompt: '', custom: true });
  const [sceneImageState, setSceneImageState] = useState<ImageGenerationUiState>(IDLE_IMAGE_GENERATION_STATE);
  const [isSceneTagPickerOpen, setIsSceneTagPickerOpen] = useState(false);
  const [newSceneTagName, setNewSceneTagName] = useState('');
  const [imageState, setImageState] = useState<ImageGenerationUiState>(IDLE_IMAGE_GENERATION_STATE);
  const [feedback, setFeedback] = useState('');
  const [isPlanDialogOpen, setIsPlanDialogOpen] = useState(false);
  const [planFoodSearch, setPlanFoodSearch] = useState('');
  const [planForm, setPlanForm] = useState<{ foodId: string; planDate: string; mealType: MealType; note: string }>(() => ({
    foodId: '',
    planDate: todayKey(),
    mealType: 'dinner',
    note: '',
  }));
  const [planDetailItemId, setPlanDetailItemId] = useState<string | null>(null);
  const [planDetailForm, setPlanDetailForm] = useState<FoodPlanDetailFormState>(() => ({
    planDate: todayKey(),
    mealType: 'dinner',
    note: '',
  }));
  const [isPlanDetailEditing, setIsPlanDetailEditing] = useState(false);

  const foodUsageCards = useMemo(
    () => props.foods.map((food) => ({ food, usage: getMealUsage(food, props.mealLogs) })),
    [props.foods, props.mealLogs]
  );
  const recipeCards = useMemo(
    () => buildRecipeCards(props.recipes, props.ingredients, props.inventoryItems, props.mealLogs, props.foods),
    [props.foods, props.ingredients, props.inventoryItems, props.mealLogs, props.recipes]
  );
  const expiringFoods = useMemo(() => props.foods.filter(isFoodExpiring), [props.foods]);
  const needsInfoFoods = useMemo(() => props.foods.filter((food) => isFoodMissingDecisionInfo(food, props.recipes)), [props.foods, props.recipes]);
  const governanceIssueSummaries = useMemo(
    () =>
      FOOD_GOVERNANCE_ISSUE_OPTIONS.map((item) => ({
        ...item,
        count: props.foods.filter((food) => getFoodGovernanceIssues(food, props.recipes).includes(item.value)).length,
      })),
    [props.foods, props.recipes]
  );
  const governanceQueue = useMemo(
    () =>
      needsInfoFoods
        .filter((food) => governanceIssueFilter === 'all' || getFoodGovernanceIssues(food, props.recipes).includes(governanceIssueFilter))
        .slice()
        .sort((a, b) => getFoodGovernanceIssues(b, props.recipes).length - getFoodGovernanceIssues(a, props.recipes).length || b.updated_at.localeCompare(a.updated_at)),
    [governanceIssueFilter, needsInfoFoods, props.recipes]
  );
  const suggestedMealType = useMemo(() => getSuggestedMealTypeForHour(), []);
  const todayRecommendations = useMemo(
    () => buildTodayFoodRecommendations(props.foods, props.mealLogs, { mealType: suggestedMealType, recipes: props.recipes }),
    [props.foods, props.mealLogs, props.recipes, suggestedMealType]
  );
  const recommendationCards = useMemo<RecommendationCardViewModel[]>(() => {
    if (props.foodRecommendations?.items.length) {
      return props.foodRecommendations.items.map((item) => ({
        food: item.food,
        mealType: props.foodRecommendations?.target_meal_type ?? suggestedMealType,
        score: item.score,
        reasons: item.reasons,
        primaryAction: item.primary_action,
        recipeAvailability: item.recipe_availability,
      }));
    }
    return todayRecommendations.map((item) => ({
      food: item.food,
      mealType: item.mealType,
      score: item.score,
      reasons: item.reasons,
      primaryAction: normalizeFoodType(item.food) === 'selfMade' && item.food.recipe_id ? 'cook_recipe' : 'quick_add_meal',
      recipeAvailability: null,
    }));
  }, [props.foodRecommendations, suggestedMealType, todayRecommendations]);
  const recommendationPageCount = Math.max(1, Math.ceil(recommendationCards.length / 3));
  const visibleRecommendations = recommendationCards.slice((recommendationPage % recommendationPageCount) * 3, (recommendationPage % recommendationPageCount) * 3 + 3);
  const repeatFoods = useMemo(
    () =>
      foodUsageCards
        .filter(({ food, usage }) => food.favorite || usage.count >= 2)
        .sort((a, b) => Number(b.food.favorite) - Number(a.food.favorite) || b.usage.count - a.usage.count)
        .slice(0, 3),
    [foodUsageCards]
  );
  const filteredFoods = useMemo(() => {
    return filterFoodWorkspaceItems(props.foods, search, typeFilter, mealFilter, lensFilter, props.recipes)
      .filter((food) => sceneFilter === 'all' || getFoodSceneTags(food).includes(sceneFilter))
      .filter((food) => lensFilter !== 'needsInfo' || governanceIssueFilter === 'all' || getFoodGovernanceIssues(food, props.recipes).includes(governanceIssueFilter))
      .slice()
      .sort((a, b) => getFoodPriority(b, props.mealLogs, lensFilter, props.recipes) - getFoodPriority(a, props.mealLogs, lensFilter, props.recipes));
  }, [governanceIssueFilter, lensFilter, mealFilter, props.foods, props.mealLogs, props.recipes, search, sceneFilter, typeFilter]);
  const sceneCards = useMemo(() => {
    const counts = new Map<string, number>();
    props.foods.forEach((food) => {
      getFoodSceneTags(food).forEach((tag) => counts.set(tag, (counts.get(tag) ?? 0) + 1));
    });
    return [
      ...props.foodScenes
        .filter((scene) => !scene.hidden)
        .map((scene) => ({
          id: scene.id,
          name: scene.name,
          description: scene.description,
          imagePrompt: scene.image_prompt,
          imageUrl: scene.image?.url,
          count: counts.get(scene.name) ?? 0,
        })),
      ...Array.from(counts.entries())
        .filter(([name]) => !props.foodScenes.some((scene) => scene.name === name))
        .map(([name, count]) => ({ id: '', name, description: '', imagePrompt: '', imageUrl: undefined, count })),
    ].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'zh-CN')).slice(0, 12);
  }, [props.foodScenes, props.foods]);
  const currentLensCopy = FOOD_LENS_COPY[lensFilter];
  const detailFood = detailFoodId ? props.foods.find((food) => food.id === detailFoodId) ?? null : null;
  const repeatFoodCount = foodUsageCards.filter(({ food, usage }) => food.favorite || usage.count >= 2).length;
  const managementIssueCount = new Set([...expiringFoods, ...needsInfoFoods].map((food) => food.id)).size;
  const nextGovernanceFood = governanceQueue[0] ?? null;
  const nextGovernanceSummary = nextGovernanceFood ? `${nextGovernanceFood.name} · ${getFoodGovernanceIssueLabels(nextGovernanceFood, props.recipes).join('、')}` : '资料已够完整';
  const hasFoodFilters = Boolean(search.trim()) || typeFilter !== 'all' || mealFilter !== 'all' || lensFilter !== 'all' || sceneFilter !== 'all' || governanceIssueFilter !== 'all';
  const todayDate = todayKey();
  const activePlanItems = props.foodPlanItems.filter((item) => item.status !== 'skipped');
  const activePlanDetailItem = planDetailItemId ? props.foodPlanItems.find((item) => item.id === planDetailItemId) ?? null : null;
  const activePlanDetailFood = activePlanDetailItem ? props.foods.find((food) => food.id === activePlanDetailItem.food_id) ?? null : null;
  const foodPlanDays = Array.from({ length: 7 }, (_, index) => {
    const date = addFoodPlanDateDays(props.foodPlanWeekRange.start, index);
    const items = activePlanItems.filter((item) => item.plan_date === date);
    return {
      date,
      label: date === todayKey() ? '今天' : formatDate(date),
      items,
    };
  });
  const planDateOptions = Array.from({ length: 7 }, (_, index) => addFoodPlanDateDays(todayDate, index));
  const planFoodOptions = useMemo(() => {
    const query = planFoodSearch.trim().toLowerCase();
    return props.foods
      .filter((food) => {
        if (!query) return true;
        return [food.name, food.category, food.source_name, food.purchase_source, food.scene, food.notes, food.routine_note, ...getFoodSceneTags(food)]
          .join(' ')
          .toLowerCase()
          .includes(query);
      })
      .slice(0, 8);
  }, [planFoodSearch, props.foods]);
  const selectedPlanFood = planForm.foodId ? props.foods.find((food) => food.id === planForm.foodId) ?? null : null;
  const mobileDefaultSceneCards = [
    {
      key: 'protein',
      title: '高蛋白',
      count: props.foods.filter((food) => [food.name, food.category, food.notes, food.routine_note, ...getFoodSceneTags(food)].join(' ').includes('蛋白')).length || props.foods.filter((food) => normalizeFoodType(food) === 'selfMade').length,
      imageFood: props.foods.find((food) => [food.name, food.category, food.notes, food.routine_note, ...getFoodSceneTags(food)].join(' ').includes('蛋白')) ?? props.foods.find((food) => normalizeFoodType(food) === 'selfMade') ?? props.foods[0],
      onClick: () => {
        setLensFilter('all');
        setTypeFilter('all');
        setMealFilter('all');
        setSearch('高蛋白');
      },
    },
    {
      key: 'dinner',
      title: '工作日晚餐',
      count: props.foods.filter((food) => food.suitable_meal_types.includes('dinner')).length,
      imageFood:
        props.foods.find((food) => food.suitable_meal_types.includes('dinner') && food.id !== props.foods[0]?.id && ![food.name, ...getFoodSceneTags(food)].join(' ').includes('蛋白')) ??
        props.foods.find((food) => food.suitable_meal_types.includes('dinner') && food.id !== props.foods[0]?.id) ??
        props.foods[1] ??
        props.foods[0],
      onClick: () => {
        setLensFilter('today');
        setTypeFilter('all');
        setMealFilter('dinner');
        setSearch('');
      },
    },
    {
      key: 'kid',
      title: '孩子也能吃',
      count: props.foods.filter((food) => [food.notes, food.routine_note, ...getFoodSceneTags(food)].join(' ').includes('孩子')).length,
      imageFood: props.foods.find((food) => [food.notes, food.routine_note, ...getFoodSceneTags(food)].join(' ').includes('孩子')) ?? props.foods[2] ?? props.foods[1] ?? props.foods[0],
      onClick: () => {
        setLensFilter('all');
        setTypeFilter('all');
        setMealFilter('all');
        setSearch('孩子');
      },
    },
    {
      key: 'light',
      title: '周末轻食',
      count: props.foods.filter((food) => [food.name, food.category, food.notes, food.routine_note, ...getFoodSceneTags(food)].join(' ').includes('轻食')).length || props.foods.filter((food) => food.suitable_meal_types.includes('snack')).length,
      imageFood:
        props.foods.find((food) => [food.name, food.category, food.notes, food.routine_note, ...getFoodSceneTags(food)].join(' ').includes('轻食')) ??
        props.foods.find((food) => food.suitable_meal_types.includes('snack')) ??
        props.foods.find((food) => !['selfMade', 'takeout'].includes(normalizeFoodType(food))) ??
        props.foods[3] ??
        props.foods[0],
      onClick: () => {
        setLensFilter('all');
        setTypeFilter('all');
        setMealFilter('snack');
        setSearch('');
      },
    },
  ];
  const mobileSceneExploreCards = [
    ...mobileDefaultSceneCards,
    ...sceneCards
      .filter((scene) => !mobileDefaultSceneCards.some((card) => card.title === scene.name))
      .map((scene) => ({
        key: `scene-${scene.name}`,
        title: scene.name,
        count: scene.count,
        imageFood: props.foods.find((food) => getFoodSceneTags(food).includes(scene.name)) ?? props.foods[0],
        imageUrl: scene.imageUrl,
        onClick: () => {
          setSceneFilter(scene.name);
          setLensFilter('all');
          setTypeFilter('all');
          setMealFilter('all');
          setSearch('');
        },
      })),
  ];
  const mobileScenePages = Array.from({ length: Math.ceil(mobileSceneExploreCards.length / 4) || 1 }, (_, index) =>
    mobileSceneExploreCards.slice(index * 4, index * 4 + 4)
  );
  const mobileLibraryFoods = filteredFoods.slice(0, 4);

  const imagePayload = getFoodImagePayload(form, props.recipes);
  const currentRecipe = props.recipes.find((recipe) => recipe.id === form.recipeId);
  const isSelfMade = form.type === 'selfMade';
  const editorProfile = getFoodEditorProfile(form.type);
  const editorCompletionItems = getFoodFormCompletionItems(form, editingFood, props.recipes);
  const editorCompletedCount = editorCompletionItems.filter((item) => item.done).length;
  const editorCompletionPercent = Math.round((editorCompletedCount / editorCompletionItems.length) * 100);
  const canSubmit = !props.isSavingFood && !imageState.isGenerating;
  const editorSceneTags = splitTags(form.sceneTags);
  const sceneTagOptions = useMemo(() => {
    const names = new Set<string>();
    props.foodScenes.filter((scene) => !scene.hidden).forEach((scene) => names.add(scene.name));
    props.foods.forEach((food) => getFoodSceneTags(food).forEach((tag) => names.add(tag)));
    editorSceneTags.forEach((tag) => names.add(tag));
    return Array.from(names).sort((left, right) => left.localeCompare(right, 'zh-CN'));
  }, [editorSceneTags, props.foodScenes, props.foods]);
  const availableSceneTagOptions = sceneTagOptions.filter((tag) => !editorSceneTags.includes(tag));
  const editorFoodTitle = isSelfMade ? currentRecipe?.title || form.name || '选择一个菜谱' : form.name || '新的食物';
  const editorRecipeCover = currentRecipe?.images[0]?.url ?? (editingFood ? getFoodCover(editingFood, props.recipes) : undefined);
  const editorRecipeMeta = currentRecipe ? `${currentRecipe.ingredient_items.length} 个原料 · ${currentRecipe.steps.length} 个步骤` : '还没有关联菜谱';

  function removeSceneTag(tag: string) {
    setForm((current) => ({
      ...current,
      sceneTags: splitTags(current.sceneTags)
        .filter((item) => item !== tag)
        .join('、'),
    }));
  }

  function addSceneTag(tag: string) {
    const nextTag = tag.trim();
    if (!nextTag) return;
    setForm((current) => {
      const tags = splitTags(current.sceneTags);
      if (tags.includes(nextTag)) return current;
      return { ...current, sceneTags: [...tags, nextTag].join('、') };
    });
    setIsSceneTagPickerOpen(false);
    setNewSceneTagName('');
  }

  async function createAndAddSceneTag() {
    const name = newSceneTagName.trim();
    if (!name) return;
    const existing = sceneTagOptions.find((tag) => tag === name);
    if (existing) {
      addSceneTag(existing);
      return;
    }
    await props.createFoodScene({
      name,
      description: '',
      image_prompt: '',
      hidden: false,
      custom: true,
      sort_order: 0,
    });
    addSceneTag(name);
  }

  function openCreate(type: FoodType = 'takeout') {
    if (normalizeFormFoodType(type) === 'selfMade') {
      props.onOpenRecipes();
      return;
    }
    setEditingFood(null);
    setForm(makeBlankFoodForm(type));
    setImageState(IDLE_IMAGE_GENERATION_STATE);
    setFeedback('');
    setIsSceneTagPickerOpen(false);
    setNewSceneTagName('');
    setView('create');
  }

  function openEdit(food: Food) {
    setDetailFoodId(null);
    setEditingFood(food);
    setForm(foodToForm(food));
    setImageState(IDLE_IMAGE_GENERATION_STATE);
    setFeedback('');
    setIsSceneTagPickerOpen(false);
    setNewSceneTagName('');
    setView('edit');
  }

  function openDetail(food: Food) {
    setDetailFoodId(food.id);
  }

  async function handleImageUpload(files: FileList | null) {
    if (!files || files.length === 0) return;
    setImageState({ isGenerating: true, errorMessage: null });
    try {
      const next = await uploadReferenceAndGenerateImage(files[0], imagePayload);
      setForm((current) => ({ ...current, images: next }));
      setImageState(IDLE_IMAGE_GENERATION_STATE);
    } catch (reason) {
      const referenceAsset = extractReferenceAsset(reason);
      if (referenceAsset) {
        setForm((current) => ({ ...current, images: { ...current.images, referenceAsset } }));
      }
      setImageState({ isGenerating: false, errorMessage: resolveImageGenerationErrorMessage(reason, '图片上传成功，但生成主图失败。') });
    }
  }

  async function handleGenerateImage(mode: 'reference' | 'text') {
    setImageState({ isGenerating: true, errorMessage: null });
    try {
      const nextImages =
        mode === 'reference' && form.images.referenceAsset
          ? await regenerateImageFromReference(form.images.referenceAsset.id, imagePayload)
          : await generateImageFromText(imagePayload);
      setForm((current) => ({ ...current, images: { ...current.images, ...nextImages } }));
      setImageState(IDLE_IMAGE_GENERATION_STATE);
    } catch (reason) {
      setImageState({ isGenerating: false, errorMessage: resolveImageGenerationErrorMessage(reason, '生成主图失败，请稍后再试。') });
    }
  }

  async function submitFood(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSubmit) return;
    const payload = buildFoodPayloadFromForm(form, props.recipes, getMediaIds(form.images));
    if (editingFood) {
      await props.updateFood(editingFood.id, payload);
    } else {
      await props.createFood(payload);
    }
    setView('list');
    setEditingFood(null);
    setForm(makeBlankFoodForm());
  }

  function toggleMealType(mealType: MealType, checked: boolean) {
    setForm((current) => ({
      ...current,
      suitableMealTypes: checked
        ? Array.from(new Set([...current.suitableMealTypes, mealType]))
        : current.suitableMealTypes.filter((item) => item !== mealType),
    }));
  }

  async function quickAdd(food: Food, mealType: MealType) {
    await props.quickAddMeal({ food_id: food.id, date: todayKey(), meal_type: mealType, servings: 1, note: '' });
    setFeedback(`${food.name} 已记到今天${MEAL_TYPE_LABELS[mealType]}`);
  }

  function openPlanDialog(food?: Food) {
    setPlanForm({
      foodId: food?.id ?? '',
      planDate: todayKey(),
      mealType: food ? getDefaultMealType(food) : 'dinner',
      note: '',
    });
    setPlanFoodSearch(food?.name ?? '');
    setIsPlanDialogOpen(true);
  }

  function clearPlanFoodSelection() {
    setPlanForm((current) => ({ ...current, foodId: '' }));
    setPlanFoodSearch('');
  }

  function closePlanDialog() {
    setIsPlanDialogOpen(false);
    setPlanFoodSearch('');
  }

  async function submitPlanItem(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!planForm.foodId) {
      window.alert('请选择要加入菜单的食物。');
      return;
    }
    try {
      await props.createFoodPlanItem({
        food_id: planForm.foodId,
        plan_date: planForm.planDate,
        meal_type: planForm.mealType,
        note: planForm.note.trim(),
      });
      closePlanDialog();
    } catch (reason) {
      window.alert(reason instanceof Error ? reason.message : '添加菜单计划失败');
    }
  }

  function openPlanDetail(item: FoodPlanItem) {
    setPlanDetailItemId(item.id);
    setPlanDetailForm({ planDate: item.plan_date < todayKey() ? todayKey() : item.plan_date, mealType: item.meal_type, note: item.note ?? '' });
    setIsPlanDetailEditing(false);
  }

  function closePlanDetail() {
    setPlanDetailItemId(null);
    setIsPlanDetailEditing(false);
  }

  function resetPlanDetailForm() {
    if (!activePlanDetailItem) return;
    setPlanDetailForm({
      planDate: activePlanDetailItem.plan_date < todayKey() ? todayKey() : activePlanDetailItem.plan_date,
      mealType: activePlanDetailItem.meal_type,
      note: activePlanDetailItem.note ?? '',
    });
    setIsPlanDetailEditing(false);
  }

  async function submitPlanDetail(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!activePlanDetailItem) return;
    try {
      await props.updateFoodPlanItem(activePlanDetailItem.id, {
        plan_date: planDetailForm.planDate,
        meal_type: planDetailForm.mealType,
        note: planDetailForm.note.trim(),
      });
      setIsPlanDetailEditing(false);
    } catch (reason) {
      window.alert(reason instanceof Error ? reason.message : '更新菜单计划失败');
    }
  }

  async function deletePlanDetail(item: FoodPlanItem) {
    try {
      await props.deleteFoodPlanItem(item.id);
      closePlanDetail();
    } catch (reason) {
      window.alert(reason instanceof Error ? reason.message : '删除菜单计划失败');
    }
  }

  async function completePlanItem(item: FoodPlanItem) {
    if (item.recipe_id) {
      props.onStartRecipe(item.recipe_id, item.id);
      return;
    }
    try {
      await props.quickAddMeal({
        food_id: item.food_id,
        date: item.plan_date,
        meal_type: item.meal_type,
        servings: 1,
        note: item.note || '来自菜单计划',
        food_plan_item_id: item.id,
      });
      setFeedback(`${item.food_name} 已完成菜单计划`);
      closePlanDetail();
    } catch (reason) {
      window.alert(reason instanceof Error ? reason.message : '完成菜单计划失败');
    }
  }

  function handleRecommendationPrimaryAction(item: RecommendationCardViewModel) {
    if (item.primaryAction === 'cook_recipe' && item.food.recipe_id) {
      props.onStartRecipe(item.food.recipe_id);
      return;
    }
    if (item.primaryAction === 'quick_add_meal') {
      void quickAdd(item.food, item.mealType);
      return;
    }
    openDetail(item.food);
  }

  function handleFoodCardPrimaryAction(food: Food, mealType: MealType) {
    if (normalizeFoodType(food) === 'selfMade' && food.recipe_id) {
      props.onStartRecipe(food.recipe_id);
      return;
    }
    void quickAdd(food, mealType);
  }

  function clearFoodFilters() {
    setSearch('');
    setTypeFilter('all');
    setMealFilter('all');
    setLensFilter('all');
    setSceneFilter('all');
    setGovernanceIssueFilter('all');
  }

  function openCreateScene(name = '') {
    setSceneDraft(blankFoodSceneDraft(name));
    setSceneImageState(IDLE_IMAGE_GENERATION_STATE);
    setSceneFormMode('create');
    setIsSceneManagerOpen(true);
  }

  function closeSceneForm() {
    setSceneFormMode(null);
    setSceneDraft(blankFoodSceneDraft());
    setSceneImageState(IDLE_IMAGE_GENERATION_STATE);
  }

  function openEditScene(scene: {
    id?: string;
    name: string;
    description?: string;
    imagePrompt?: string;
    imageUrl?: string;
    custom?: boolean;
  }) {
    if (!scene.id) {
      openCreateScene(scene.name);
      return;
    }
    setSceneDraft({
      id: scene.id,
      name: scene.name,
      description: scene.description ?? '',
      imagePrompt: scene.imagePrompt ?? '',
      imageAssetUrl: scene.imageUrl,
      custom: scene.custom ?? true,
      hidden: false,
    });
    setSceneImageState(IDLE_IMAGE_GENERATION_STATE);
    setSceneFormMode('edit');
    setIsSceneManagerOpen(true);
  }

  async function submitScene(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const name = sceneDraft.name.trim();
    if (!name) return;
    const payload = {
      name,
      description: sceneDraft.description.trim(),
      image_prompt: sceneDraft.imagePrompt.trim(),
      image_asset_id: sceneDraft.imageAssetId,
      hidden: false,
      custom: true,
      sort_order: 0,
    };
    if (sceneDraft.id) {
      await props.updateFoodScene(sceneDraft.id, payload);
    } else {
      await props.createFoodScene(payload);
    }
    closeSceneForm();
  }

  async function deleteScene(sceneId: string) {
    await props.deleteFoodScene(sceneId);
    if (sceneDraft.id === sceneId) {
      closeSceneForm();
    }
  }

  async function generateFoodSceneImage() {
    const name = sceneDraft.name.trim();
    if (!name) {
      setSceneImageState({ isGenerating: false, errorMessage: '请先填写场景名称。' });
      return;
    }
    setSceneImageState({ isGenerating: true, errorMessage: null });
    try {
      const nextImages = await generateImageFromText(buildFoodSceneImagePayload(sceneDraft));
      const generatedAsset = nextImages.generatedAsset;
      if (!generatedAsset) {
        throw new Error('AI 封面生成失败');
      }
      setSceneDraft((current) => ({
        ...current,
        name,
        description: current.description.trim(),
        imagePrompt: current.imagePrompt.trim(),
        imageAssetId: generatedAsset.id,
        imageAssetUrl: generatedAsset.url,
      }));
      setSceneImageState(IDLE_IMAGE_GENERATION_STATE);
    } catch (reason) {
      setSceneImageState({ isGenerating: false, errorMessage: resolveImageGenerationErrorMessage(reason, '场景封面生成失败') });
    }
  }

  function openGovernanceIssue(issue: 'all' | FoodGovernanceIssue) {
    setLensFilter('needsInfo');
    setGovernanceIssueFilter(issue);
  }

  function openNextGovernanceFood() {
    const nextFood = governanceQueue[0];
    if (!nextFood) return;
    openEdit(nextFood);
  }

  if (view !== 'list') {
    return (
      <main className="food-workspace">
        <WorkspaceSubpageShell className="food-editor-shell">
          <WorkspaceSubpageHeader
            eyebrow="食物"
            title={view === 'create' ? '新增食物' : '编辑食物'}
            description={isSelfMade ? '家常菜由菜谱提供核心信息，这里只做映射和常用记录。' : '补充来源、价格、复购和保质信息，让常吃食物更容易再次安排。'}
            backLabel="返回食物库"
            onBack={() => setView('list')}
            meta={<Badge>{FOOD_TYPE_LABELS[form.type]}</Badge>}
            variant="compact"
          />
          <form className="food-editor-layout" onSubmit={submitFood}>
            <section className="food-editor-main">
              <div className="food-form-panel food-editor-identity-panel">
                <div className="section-mini-title">{isSelfMade ? '关联菜谱' : '先选类型，再填名称'}</div>
                {!isSelfMade && (
                  <div className="food-type-grid">
                    {FOOD_CREATE_TYPE_OPTIONS.map((item) => {
                      const detail = FOOD_CREATE_TYPE_DETAILS[item.value];
                      return (
                        <button
                          key={item.value}
                          className={form.type === item.value ? 'food-type-card active' : 'food-type-card'}
                          type="button"
                          onClick={() => setForm({ ...form, type: item.value, category: '' })}
                        >
                          <span className="food-type-card-icon">{detail && <FoodUiIcon name={detail.icon} />}</span>
                          <span className="food-type-card-copy">
                            <strong>{item.label}</strong>
                            <small>{detail?.description}</small>
                          </span>
                        </button>
                      );
                    })}
                  </div>
                )}
                {isSelfMade ? (
                  <div className="food-editor-recipe-card">
                    <div className="food-editor-recipe-cover">
                      {editorRecipeCover ? <img src={resolveFoodAssetUrl(editorRecipeCover)} alt="" /> : <FoodUiIcon name="bowl" />}
                    </div>
                    <div className="food-editor-recipe-copy">
                      <strong>{currentRecipe?.title || form.name || '还没有关联菜谱'}</strong>
                      <span>名称、主图、食材和做法来自菜谱；这里维护餐别、场景和备注。</span>
                    </div>
                    <ActionButton tone="secondary" size="compact" type="button" onClick={props.onOpenRecipes}>
                      <span>去菜谱页</span>
                      <FoodUiIcon name="arrowRight" />
                    </ActionButton>
                  </div>
                ) : (
                  <div className="form-grid nested-grid food-name-grid">
                    <label>
                      <span>食物名称</span>
                      <input className="text-input" placeholder="例如：公司楼下牛肉饭、全家饭团" value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} />
                    </label>
                  </div>
                )}
              </div>

              {!isSelfMade && (
                <ImageComposer
                  title="食物图片"
                  value={form.images}
                  previewLabel={form.name || currentRecipe?.title || '食物'}
                  onUpload={(files) => void handleImageUpload(files)}
                  onGenerate={(mode) => void handleGenerateImage(mode)}
                  onReset={() => {
                    setForm({ ...form, images: emptyImages() });
                    setImageState(IDLE_IMAGE_GENERATION_STATE);
                  }}
                  isGenerating={imageState.isGenerating}
                  errorMessage={imageState.errorMessage}
                  variant="workspace-inline"
                />
              )}

              <div className={isOutsideType(form.type) ? 'food-form-panel food-editor-focus-panel food-editor-repurchase-panel' : 'food-form-panel food-editor-focus-panel'}>
                {isSelfMade ? (
                  <div className="food-editor-map-summary">
                    <div className="food-editor-map-icon">
                      <FoodUiIcon name="clipboard" />
                    </div>
                    <div>
                      <div className="section-mini-title">食物映射摘要</div>
                      <strong>{editorFoodTitle} · {editorRecipeMeta}</strong>
                      <p className="subtle">做法与步骤以菜谱页为准，这里仅维护映射信息与常用记录。</p>
                    </div>
                  </div>
                ) : (
                  <>
                    <div className="food-editor-focus-head">
                      <div>
                        <div className="section-mini-title">{editorProfile.title}</div>
                        <p className="subtle">{editorProfile.description}</p>
                      </div>
                      <Badge>{FOOD_TYPE_LABELS[normalizeFormFoodType(form.type)]}</Badge>
                    </div>
                    <div className={isOutsideType(form.type) ? 'food-repurchase-panel-grid' : 'form-grid nested-grid'}>
                      <label>
                        <span>{isOutsideType(form.type) ? (form.type === 'takeout' ? '店铺' : '餐厅') : '品牌 / 来源'}</span>
                        <input className="text-input" placeholder={isOutsideType(form.type) ? (form.type === 'takeout' ? '例如：麦当劳、常点轻食店' : '例如：楼下日料店') : '例如：品牌或来源'} value={form.sourceName} onChange={(event) => setForm({ ...form, sourceName: event.target.value })} />
                      </label>
                      <label>
                        <span>{isOutsideType(form.type) ? '平台 / 位置' : '购买渠道'}</span>
                        <input className="text-input" placeholder={isOutsideType(form.type) ? (form.type === 'takeout' ? '例如：美团、饿了么' : '例如：商场、街区') : '例如：超市、便利店'} value={form.purchaseSource} onChange={(event) => setForm({ ...form, purchaseSource: event.target.value })} />
                      </label>
                      {isOutsideType(form.type) && (
                        <>
                          <label>
                            <span>价格 / 人均</span>
                            <input className="text-input" type="number" min="0" step="0.01" placeholder="例如：38" value={form.price} onChange={(event) => setForm({ ...form, price: event.target.value })} />
                          </label>
                          <label>
                            <span>评分</span>
                            <FoodRatingInput value={form.rating} onChange={(rating) => setForm((current) => ({ ...current, rating }))} />
                          </label>
                          <div className="food-repurchase-choice-field">
                            <span>复购意愿</span>
                            <div className="food-repurchase-choice-group" role="radiogroup" aria-label="复购意愿">
                              {[
                                { value: 'unknown', label: '未记录' },
                                { value: 'yes', label: '愿意复购' },
                                { value: 'no', label: '暂不复购' },
                              ].map((item) => (
                                <button
                                  key={item.value}
                                  className={form.repurchase === item.value ? 'active' : ''}
                                  type="button"
                                  role="radio"
                                  aria-checked={form.repurchase === item.value}
                                  onClick={() => setForm((current) => ({ ...current, repurchase: item.value as FoodFormState['repurchase'] }))}
                                >
                                  {item.label}
                                </button>
                              ))}
                            </div>
                          </div>
                        </>
                      )}
                      {isReadyLikeType(form.type) && (
                        <>
                          <label>
                            <span>保质日期</span>
                            <input className="text-input" type="date" value={form.expiryDate} onChange={(event) => setForm({ ...form, expiryDate: event.target.value })} />
                          </label>
                          <label>
                            <span>剩余数量</span>
                            <input className="text-input" type="number" min="0" step="0.5" value={form.stockQuantity} onChange={(event) => setForm({ ...form, stockQuantity: event.target.value })} />
                          </label>
                          <label>
                            <span>数量单位</span>
                            <input className="text-input" value={form.stockUnit} onChange={(event) => setForm({ ...form, stockUnit: event.target.value })} />
                          </label>
                        </>
                      )}
                    </div>
                  </>
                )}
              </div>

              <div className={isSelfMade ? 'food-form-panel food-editor-notes-panel' : 'food-form-panel'}>
                <div className="section-mini-title">餐别、场景标签和备注</div>
                <div className="food-editor-field-row food-editor-meal-row">
                  <span>适合餐别</span>
                  <div className="food-meal-checks">
                  {MEAL_OPTIONS.map((item) => (
                    <label key={item.value} className="food-check-pill">
                      <input
                        type="checkbox"
                        checked={form.suitableMealTypes.includes(item.value)}
                        onChange={(event) => toggleMealType(item.value, event.target.checked)}
                      />
                      <FoodUiIcon name={item.value === 'dinner' ? 'moon' : item.value === 'snack' ? 'bowl' : 'sun'} />
                      <span>{item.label}</span>
                    </label>
                  ))}
                  </div>
                </div>
                <div className="food-editor-field-row">
                  <span>场景标签</span>
                  <div className="food-editor-tag-stack">
                    <div className="food-editor-scene-tags">
                      {editorSceneTags.map((tag) => (
                        <button key={tag} type="button" onClick={() => removeSceneTag(tag)}>
                          {tag}
                          <span>×</span>
                        </button>
                      ))}
                      <button className="food-editor-add-tag" type="button" onClick={() => setIsSceneTagPickerOpen((current) => !current)}>
                        <FoodUiIcon name="plus" />
                        添加标签
                      </button>
                    </div>
                    {isSceneTagPickerOpen && (
                      <div className="food-scene-tag-picker">
                        <div className="food-scene-tag-picker-head">
                          <strong>选择已有标签</strong>
                          <span>{availableSceneTagOptions.length > 0 ? '点击后加入当前食物' : '已有标签都已选中'}</span>
                        </div>
                        {availableSceneTagOptions.length > 0 ? (
                          <div className="food-scene-tag-options">
                            {availableSceneTagOptions.map((tag) => (
                              <button key={tag} type="button" onClick={() => addSceneTag(tag)}>
                                {tag}
                              </button>
                            ))}
                          </div>
                        ) : (
                          <p className="food-scene-tag-empty">暂无可选标签，可以创建一个新标签。</p>
                        )}
                        <div className="food-scene-tag-create">
                          <input className="text-input" value={newSceneTagName} placeholder="创建新标签，例如：周末轻食" onChange={(event) => setNewSceneTagName(event.target.value)} />
                          <ActionButton tone="secondary" size="compact" type="button" disabled={props.isUpdatingScene || !newSceneTagName.trim()} onClick={() => void createAndAddSceneTag()}>
                            创建并添加
                          </ActionButton>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
                <div className="food-editor-field-row">
                  <span>常用备注</span>
                  <div className="food-editor-note-input">
                    <input className="text-input" maxLength={50} value={form.routineNote} placeholder="例如：孩子也能吃、适合减脂、少油少盐" onChange={(event) => setForm({ ...form, routineNote: event.target.value })} />
                    <small>{form.routineNote.length}/50</small>
                  </div>
                </div>
                <div className="food-editor-field-row">
                  <span>详细备注</span>
                  <div className="food-editor-note-input">
                    <textarea className="text-input" maxLength={200} rows={3} value={form.notes} onChange={(event) => setForm({ ...form, notes: event.target.value })} />
                    <small>{form.notes.length}/200</small>
                  </div>
                </div>
                <label className="food-editor-favorite-row">
                  <div>
                    <span>加入收藏</span>
                    <small>收藏后可在食物库快速找到</small>
                  </div>
                  <input type="checkbox" checked={form.favorite} onChange={(event) => setForm({ ...form, favorite: event.target.checked })} />
                  <i aria-hidden="true" />
                </label>
              </div>
            </section>

            <aside className="food-editor-side">
              <div className="food-editor-summary sticky-panel">
                <p className="eyebrow">即将保存</p>
                <h3>{editorFoodTitle}</h3>
                <p className="subtle">{isSelfMade ? '家常菜的名称、主图和做法以菜谱为准。' : '保存后可从卡片直接加入今天餐食。'}</p>
                {isSelfMade && !form.recipeId && <div className="workspace-inline-note">家常菜需要先关联一个菜谱。</div>}
                <div className="food-editor-completion">
                  <div className="food-editor-completion-head">
                    <span>资料完整度</span>
                    <strong>{editorCompletionPercent}%</strong>
                  </div>
                  <div className="food-editor-completion-bar">
                    <span style={{ width: `${editorCompletionPercent}%` }} />
                  </div>
                  <div className="food-editor-completion-list">
                    {editorCompletionItems.map((item) => (
                      <span key={item.label} className={item.done ? 'done' : ''}>
                        {item.label}
                      </span>
                    ))}
                  </div>
                </div>
                <div className="workspace-rail-actions">
                  <ActionButton tone="primary" type="submit" disabled={!canSubmit}>
                    <FoodUiIcon name="save" />
                    <span>{props.isSavingFood ? '保存中...' : imageState.isGenerating ? '生成主图中...' : view === 'create' ? '保存食物' : '保存修改'}</span>
                  </ActionButton>
                  <ActionButton tone="secondary" type="button" onClick={() => setView('list')}>
                    <FoodUiIcon name="arrowLeft" />
                    <span>返回食物库</span>
                  </ActionButton>
                </div>
              </div>
            </aside>
          </form>
        </WorkspaceSubpageShell>
      </main>
    );
  }

  return (
    <main className="food-workspace">
      <section className="mobile-food-page" aria-label="手机食物页">
        <div className="mobile-food-topbar">
          <div className="mobile-food-brand">
            <span className="mobile-food-logo">
              <FoodUiIcon name="logo" />
            </span>
            <span>
              <strong>Culina</strong>
              <small>家庭厨房工作台</small>
            </span>
          </div>
          <div className="mobile-food-top-actions">
            <button type="button" aria-label="聚焦搜索" onClick={() => document.getElementById('mobile-food-search')?.focus()}>
              <FoodUiIcon name="search" />
            </button>
            <button type="button" aria-label="查看食物提醒" onClick={() => openGovernanceIssue('all')}>
              <FoodUiIcon name="bell" />
              {managementIssueCount > 0 && <i aria-hidden="true" />}
            </button>
          </div>
        </div>

        <header className="mobile-food-hero">
          <h1>食物</h1>
          <p>从常吃、临期、外卖和记录里快速选一份今天想吃的。</p>
        </header>

        <section className="mobile-dashboard-panel mobile-dashboard-recommend">
          <div className="mobile-dashboard-section-head">
            <h2>今天吃什么 <span>✦</span></h2>
            <button
              type="button"
              onClick={() => setRecommendationPage((current) => (current + 1) % recommendationPageCount)}
              disabled={recommendationCards.length <= 3}
            >
              换一换
            </button>
          </div>
          {visibleRecommendations.length > 0 ? (
            <div className="mobile-dashboard-food-scroller">
              {visibleRecommendations.map((item) => {
                const food = item.food;
                const foodCoverUrl = getFoodCover(food, props.recipes);
                return (
                  <article key={food.id} className="mobile-dashboard-food-card">
                    <div
                      className="mobile-dashboard-food-cover"
                      style={foodCoverUrl ? { backgroundImage: `url("${resolveFoodAssetUrl(foodCoverUrl)}")` } : undefined}
                    />
                    <div className="mobile-dashboard-food-body">
                      <h3>{food.name}</h3>
                      <div className="mobile-dashboard-chip-row">
                        <Badge>{FOOD_TYPE_LABELS[normalizeFoodType(food)]}</Badge>
                        <Badge>{food.routine_note || `${food.suitable_meal_types.length || 1} 餐适合`}</Badge>
                      </div>
                      <p>{item.reasons[0] ?? food.notes ?? '适合今天安排'}</p>
                      <div className="mobile-dashboard-food-actions">
                        <button
                          className="mobile-dashboard-primary compact"
                          type="button"
                          disabled={props.isQuickAdding}
                          onClick={() => handleRecommendationPrimaryAction(item)}
                        >
                          {getRecommendationPrimaryActionLabel(item)}
                        </button>
                        <button type="button" onClick={() => openDetail(food)} aria-label={`查看食物：${food.name}`}>
                          <FoodUiIcon name="list" />
                        </button>
                        <button
                          type="button"
                          onClick={() => openPlanDialog(food)}
                          disabled={props.isUpdatingPlan}
                          aria-label={`加入菜单：${food.name}`}
                        >
                          <FoodUiIcon name="calendar" />
                        </button>
                      </div>
                    </div>
                  </article>
                );
              })}
            </div>
          ) : (
            <EmptyState title="暂无推荐" description="补充食物或菜谱后，这里会出现今日建议。" />
          )}
        </section>

        <section className="mobile-food-panel">
          <div className="mobile-food-section-head">
            <h2>按场景探索</h2>
            <button type="button" onClick={() => setIsSceneManagerOpen(true)}>
              查看更多
              <FoodUiIcon name="arrowRight" />
            </button>
          </div>
          <div className="mobile-food-scene-scroller" aria-label="按场景探索">
            {mobileScenePages.map((page, pageIndex) => (
              <div className="mobile-food-scene-grid" key={`scene-page-${pageIndex}`}>
                {page.map((item) => {
                  const sceneImageUrl = 'imageUrl' in item && typeof item.imageUrl === 'string' ? item.imageUrl : undefined;
                  const cover = sceneImageUrl ?? (item.imageFood ? getFoodCover(item.imageFood, props.recipes) : null);
                  return (
                    <button key={item.key} type="button" onClick={item.onClick}>
                      {cover ? <img src={resolveFoodAssetUrl(cover)} alt="" /> : <i aria-hidden="true">{item.title.slice(0, 2)}</i>}
                      <span>
                        <strong>{item.title}</strong>
                        <small>{item.count} 份食物</small>
                      </span>
                      <b aria-hidden="true">
                        <FoodUiIcon name="arrowRight" />
                      </b>
                    </button>
                  );
                })}
              </div>
            ))}
          </div>
        </section>

        <section className="mobile-food-panel mobile-food-library">
          <div className="mobile-food-section-head">
            <h2>食物库</h2>
            <button type="button" onClick={hasFoodFilters ? clearFoodFilters : () => openCreate('takeout')}>
              {hasFoodFilters ? '查看全部' : '新增'}
              <FoodUiIcon name="arrowRight" />
            </button>
          </div>
          <div className="mobile-food-library-filters">
            <label className="mobile-food-search">
              <FoodUiIcon name="search" />
              <input id="mobile-food-search" value={search} placeholder="搜索食物、食材或菜谱" onChange={(event) => setSearch(event.target.value)} />
            </label>
            <div className="mobile-food-tabs" aria-label="食物分类">
              {[
                {
                  label: '全部',
                  active: lensFilter === 'all' && typeFilter === 'all' && mealFilter === 'all' && sceneFilter === 'all' && governanceIssueFilter === 'all',
                  onClick: clearFoodFilters,
                },
                {
                  label: '家常菜',
                  active: typeFilter === 'selfMade',
                  onClick: () => {
                    setLensFilter('all');
                    setTypeFilter('selfMade');
                    setMealFilter('all');
                    setSceneFilter('all');
                    setGovernanceIssueFilter('all');
                  },
                },
                {
                  label: '外卖',
                  active: typeFilter === 'takeout',
                  onClick: () => {
                    setLensFilter('all');
                    setTypeFilter('takeout');
                    setMealFilter('all');
                    setSceneFilter('all');
                    setGovernanceIssueFilter('all');
                  },
                },
                {
                  label: '临期待补',
                  active: lensFilter === 'expiring' || lensFilter === 'needsInfo',
                  onClick: () => {
                    setLensFilter(expiringFoods.length > 0 ? 'expiring' : 'needsInfo');
                    setTypeFilter('all');
                    setMealFilter('all');
                    setSceneFilter('all');
                    setGovernanceIssueFilter('all');
                  },
                },
                {
                  label: '收藏',
                  active: lensFilter === 'favorite',
                  onClick: () => {
                    setLensFilter('favorite');
                    setTypeFilter('all');
                    setMealFilter('all');
                    setSceneFilter('all');
                    setGovernanceIssueFilter('all');
                  },
                },
              ].map((item) => (
                <button key={item.label} className={item.active ? 'active' : ''} type="button" onClick={item.onClick}>
                  {item.label}
                </button>
              ))}
            </div>
          </div>
          {mobileLibraryFoods.length > 0 ? (
            <div className="mobile-food-library-grid">
              {mobileLibraryFoods.map((food) => {
                const cover = getFoodCover(food, props.recipes);
                const usage = getMealUsage(food, props.mealLogs);
                return (
                  <article key={food.id} className="mobile-food-library-card">
                    <button className="mobile-food-library-cover" type="button" onClick={() => openDetail(food)}>
                      {cover ? <img src={resolveFoodAssetUrl(cover)} alt={food.name} /> : <span>{food.name.slice(0, 2)}</span>}
                    </button>
                    <div className="mobile-food-library-body">
                      <h3>{food.name}</h3>
                      <p>{[FOOD_TYPE_LABELS[normalizeFoodType(food)], usage.count > 0 ? `最近做过` : '未记录'].join(' · ')}</p>
                      <div className="mobile-food-chip-row">
                        {(getFoodSceneTags(food).slice(0, 2).length ? getFoodSceneTags(food).slice(0, 2) : food.suitable_meal_types.slice(0, 2).map((meal) => MEAL_TYPE_LABELS[meal])).map((label) => (
                          <span key={label}>{label}</span>
                        ))}
                      </div>
                      <div className="mobile-food-card-actions">
                        <button className="mobile-food-primary" type="button" disabled={props.isQuickAdding} onClick={() => handleFoodCardPrimaryAction(food, getDefaultMealType(food))}>
                          {getFoodCardPrimaryActionLabel(food)}
                        </button>
                        <button type="button" aria-label={`收藏：${food.name}`} disabled={props.isUpdatingFavorite} onClick={() => void props.updateFoodFavorite(food.id, !food.favorite)}>
                          <FoodUiIcon name={food.favorite ? 'heart' : 'star'} />
                        </button>
                      </div>
                    </div>
                  </article>
                );
              })}
            </div>
          ) : (
            <div className="mobile-food-empty">
              <strong>{currentLensCopy.emptyTitle}</strong>
              <button type="button" onClick={clearFoodFilters}>清空筛选</button>
            </div>
          )}
        </section>
      </section>

      <div className="food-desktop-view">
      <PageHeader
        variant="compact"
        title="食物"
        description="从常吃、临期、外卖外食和可记录的家常菜里快速选一份，马上记到今天。"
        actions={
          <div className="hero-actions">
            <ActionButton tone="primary" type="button" onClick={() => openCreate('takeout')}>
              <FoodUiIcon name="plus" />
              <span>新增外卖/成品</span>
            </ActionButton>
            <ActionButton tone="secondary" type="button" onClick={props.onOpenLogs}>
              <FoodUiIcon name="receipt" />
              <span>完整记一餐</span>
            </ActionButton>
          </div>
        }
      />

      <div className="food-content-layout">
        <div className="food-content-main">
      <section className="food-quick-strip" aria-label="食物智能推荐">
        <div className="food-quick-head">
          <div className="food-quick-title">
            <strong>今日推荐</strong>
          </div>
          <div className="food-quick-actions">
            <button
              type="button"
              aria-label="换一换"
              title="换一换"
              onClick={() => setRecommendationPage((current) => (current + 1) % recommendationPageCount)}
              disabled={recommendationCards.length <= 3}
            >
              <FoodUiIcon name="refresh" />
              <span>换一换</span>
            </button>
          </div>
        </div>
        {visibleRecommendations.length > 0 ? (
          <div className="food-recommendation-grid">
            {visibleRecommendations.map((item) => {
              const cover = getFoodCover(item.food, props.recipes);
              const normalizedType = normalizeFoodType(item.food);
              return (
                <article key={item.food.id} className={`food-recommendation-card tone-${normalizedType}`}>
                  <div className="food-recommendation-media">
                    {cover ? <img src={resolveFoodAssetUrl(cover)} alt="" /> : <span>{item.food.name.slice(0, 2)}</span>}
                  </div>
                  <div className="food-recommendation-body">
                    <div className="food-recommendation-heading">
                      <h4>{item.food.name}</h4>
                      <span className="food-recommendation-type">{FOOD_TYPE_LABELS[normalizedType]}</span>
                    </div>
                    <div className="food-recommendation-reasons">
                      {item.reasons.map((reason) => <Badge key={reason}>{reason}</Badge>)}
                    </div>
                    <div className="food-recommendation-actions">
                      <button
                        className="primary"
                        type="button"
                        title={getRecommendationPrimaryActionLabel(item)}
                        disabled={props.isQuickAdding}
                        onClick={() => handleRecommendationPrimaryAction(item)}
                      >
                        {getRecommendationPrimaryActionLabel(item)}
                      </button>
                      <button className="icon-only" type="button" aria-label={`查看详情：${item.food.name}`} title="查看详情" onClick={() => openDetail(item.food)}>
                        <FoodUiIcon name="list" />
                      </button>
                      <button className="icon-only" type="button" aria-label={`加入菜单：${item.food.name}`} title="加入菜单" onClick={() => openPlanDialog(item.food)}>
                        <FoodUiIcon name="calendar" />
                      </button>
                    </div>
                  </div>
                </article>
              );
            })}
          </div>
        ) : (
          <div className="food-recommendation-empty">
            <strong>还没有可推荐食物</strong>
            <span>先新增外卖、成品或去菜谱页沉淀家常菜。</span>
            <button type="button" onClick={() => openCreate('takeout')}>新增可吃项</button>
          </div>
        )}
      </section>

      <section className="food-filter-shell">
          <div className="food-library-main">
            <div className="food-library-head">
              <div className="workspace-toolbar-copy">
                <h3>食物库</h3>
              </div>
              <label className="food-search-field">
                <FoodUiIcon name="search" />
                <input className="text-input" placeholder="搜索食物、来源、口味或备注..." value={search} onChange={(event) => setSearch(event.target.value)} />
              </label>
              <div className="food-library-head-actions">
                <p className="workspace-toolbar-summary">显示 {filteredFoods.length} / {props.foods.length} 份食物</p>
                {hasFoodFilters && (
                  <button className="food-clear-filters-button" type="button" onClick={clearFoodFilters}>
                    <FoodUiIcon name="refresh" />
                    <span>清空筛选</span>
                  </button>
                )}
              </div>
            </div>
              <div className="food-toolbar-controls">
                <div className="food-filter-group">
                  <span>类型</span>
                  <SegmentedTabs
                    options={[{ value: 'all', label: '全部' }, ...FOOD_TYPE_OPTIONS.map((item) => ({ value: item.value, label: item.label }))]}
                    value={typeFilter}
                    onChange={(value) => setTypeFilter(value)}
                  />
                </div>
                <div className="food-filter-group">
                  <span>餐别</span>
                  <SegmentedTabs
                    options={[{ value: 'all', label: '全餐别' }, ...MEAL_OPTIONS.map((item) => ({ value: item.value, label: item.label }))]}
                    value={mealFilter}
                    onChange={(value) => setMealFilter(value)}
                  />
                </div>
              </div>
              {lensFilter === 'needsInfo' && (
                <section className="food-governance-panel" aria-label="待完善补资料模式">
                  <div className="food-governance-head">
                    <div>
                      <span className="eyebrow">补资料</span>
                      <h4>{governanceQueue.length > 0 ? `还有 ${governanceQueue.length} 份会影响推荐` : '资料已够完整'}</h4>
                      <p>{nextGovernanceFood ? nextGovernanceSummary : '当前没有需要补齐的食物。'}</p>
                    </div>
                    <button
                      type="button"
                      disabled={governanceQueue.length === 0}
                      onClick={openNextGovernanceFood}
                    >
                      下一条
                    </button>
                  </div>
                  <div className="food-governance-chips">
                    <button
                      type="button"
                      className={governanceIssueFilter === 'all' ? 'active' : ''}
                      onClick={() => openGovernanceIssue('all')}
                    >
                      <span>全部待补</span>
                      <strong>{needsInfoFoods.length}</strong>
                    </button>
                    {governanceIssueSummaries.map((item) => (
                      <button
                        key={item.value}
                        type="button"
                        className={governanceIssueFilter === item.value ? 'active' : ''}
                        onClick={() => openGovernanceIssue(item.value)}
                        title={item.description}
                      >
                        <span>{item.label}</span>
                        <strong>{item.count}</strong>
                      </button>
                    ))}
                  </div>
                </section>
              )}
          </div>
      </section>

      {feedback && (
        <div className="food-feedback">
          <span>{feedback}</span>
          <button type="button" onClick={props.onOpenLogs}>去补详情</button>
        </div>
      )}

      {filteredFoods.length > 0 ? (
        <section className="food-card-grid">
          {filteredFoods.map((food) => {
            const usage = getMealUsage(food, props.mealLogs);
            const cover = getFoodCover(food, props.recipes);
            const expiry = describeExpiry(food);
            const normalizedType = normalizeFoodType(food);
            const defaultMealType = getDefaultMealType(food);
            const status = getFoodStatus(food, usage, expiry, props.recipes);
            const governanceIssueLabels = getFoodGovernanceIssueLabels(food, props.recipes);
            const compactLabels = governanceIssueLabels.length > 0
              ? governanceIssueLabels.slice(0, 2)
              : [...getFoodSceneTags(food).slice(0, 2), food.rating != null ? `${food.rating} 分` : null].filter((item): item is string => Boolean(item));
            return (
              <article key={food.id} className={`food-work-card tone-${normalizedType}`}>
                <div className="food-work-card-media">
                  {cover ? <img src={resolveFoodAssetUrl(cover)} alt={food.name} /> : <span>{food.name.slice(0, 4)}</span>}
                  <span className="food-type-overlay">{FOOD_TYPE_LABELS[normalizedType]}</span>
                  <button
                    className={food.favorite ? 'food-favorite-chip active' : 'food-favorite-chip'}
                    type="button"
                    aria-label={food.favorite ? '取消收藏' : '收藏食物'}
                    disabled={props.isUpdatingFavorite}
                    onClick={() => void props.updateFoodFavorite(food.id, !food.favorite)}
                  >
                    <FoodUiIcon name="heart" />
                  </button>
                </div>
                <div className="food-work-card-body">
                  <div className="food-card-title-row">
                    <div>
                      <h3>{food.name}</h3>
                    </div>
                    {food.price != null && <strong className="food-price">¥{food.price}</strong>}
                  </div>
                  <p className="food-card-meta">
                    {[food.source_name || food.purchase_source, food.category, usage.count > 0 ? `吃过 ${usage.count} 次` : '还未记录'].filter(Boolean).join(' · ')}
                  </p>
                  <div className="food-card-status-row">
                    <span className={`food-card-status tone-${status.tone}`}>
                      <strong>{status.label}</strong>
                      <small>{status.detail}</small>
                    </span>
                    {food.suitable_meal_types.length > 0 && (
                      <span className="food-card-meal-summary">
                        {food.suitable_meal_types.map((meal) => MEAL_TYPE_LABELS[meal]).join(' / ')}
                      </span>
                    )}
                  </div>
                  {compactLabels.length > 0 && (
                    <div className="food-card-issue-row" aria-label="待完善项目">
                      {compactLabels.map((label) => <span key={label}>{label}</span>)}
                    </div>
                  )}
                  <div className="food-card-actions">
                    <ActionButton tone="primary" size="compact" className="food-card-primary-action" type="button" disabled={props.isQuickAdding} onClick={() => handleFoodCardPrimaryAction(food, defaultMealType)}>
                      <FoodUiIcon name="plus" />
                      <span>{getFoodCardPrimaryActionLabel(food)}</span>
                    </ActionButton>
                    <button className="food-card-detail-button" type="button" aria-label={`查看详情：${food.name}`} title="查看详情" onClick={() => openDetail(food)}>
                      <FoodUiIcon name="list" />
                    </button>
                    <button className="food-card-detail-button" type="button" aria-label={`加入菜单：${food.name}`} title="加入菜单" onClick={() => openPlanDialog(food)}>
                      <FoodUiIcon name="calendar" />
                    </button>
                  </div>
                </div>
              </article>
            );
          })}
        </section>
      ) : (
        <EmptyState
          title={currentLensCopy.emptyTitle}
          description={search || typeFilter !== 'all' || mealFilter !== 'all' || sceneFilter !== 'all' ? '当前视角里还有额外筛选条件，可以先清空筛选再看。' : currentLensCopy.emptyDescription}
          action={
            search || typeFilter !== 'all' || mealFilter !== 'all' || sceneFilter !== 'all' ? (
              <ActionButton tone="secondary" type="button" onClick={clearFoodFilters}>清空筛选</ActionButton>
            ) : lensFilter === 'selfMade' ? (
              <ActionButton tone="primary" type="button" onClick={props.onOpenRecipes}>去新增菜谱</ActionButton>
            ) : (
              <ActionButton tone="primary" type="button" onClick={() => openCreate('takeout')}>新增食物</ActionButton>
            )
          }
        />
      )}
        </div>
        <aside className="food-task-sidebar" aria-label="食物页辅助操作">
          <div className="food-task-sidebar-head">
            <span className="eyebrow">辅助操作</span>
            <strong>食物管理</strong>
          </div>
          <div className="food-sidebar-section">
            <div className="food-sidebar-section-head">
              <strong>常用视角</strong>
            </div>
            <div className="food-library-insight" aria-label="食物快速视角">
              <button type="button" onClick={() => setLensFilter('favorite')} title={repeatFoods.map(({ food }) => food.name).join('、') || '常吃清单'}>
                <span>常吃清单</span>
                <strong>{repeatFoodCount}</strong>
              </button>
              <button type="button" onClick={() => (expiringFoods.length > 0 ? setLensFilter('expiring') : openGovernanceIssue('all'))}>
                <span>临期/待补</span>
                <strong>{managementIssueCount}</strong>
              </button>
              <button type="button" onClick={() => openGovernanceIssue('all')}>
                <span>待完善</span>
                <strong>{needsInfoFoods.length}</strong>
              </button>
            </div>
          </div>
          <div className="food-sidebar-section">
            <div className="food-sidebar-section-head">
              <strong>管理</strong>
            </div>
            <div className="food-library-insight" aria-label="食物管理入口">
              <button type="button" onClick={() => setIsSceneManagerOpen(true)}>
                <span>场景管理</span>
                <strong>{props.foodScenes.filter((scene) => !scene.hidden).length}</strong>
              </button>
            </div>
            <div className="food-library-next-task">
              <span>{nextGovernanceFood ? '下一条' : '待办'}</span>
              <strong>{nextGovernanceSummary}</strong>
              <button type="button" disabled={!nextGovernanceFood} onClick={openNextGovernanceFood}>
                处理下一条
              </button>
            </div>
          </div>
          <div className="food-sidebar-section">
            <div className="food-sidebar-section-head">
              <strong>菜单计划</strong>
              <span>{props.foodPlanWeekRange.start.slice(5).replace('-', '/')} - {props.foodPlanWeekRange.end.slice(5).replace('-', '/')}</span>
            </div>
            <div className="recipe-plan-switcher food-plan-switcher" aria-label="切换菜单周">
              <button type="button" onClick={props.onFoodPlanPreviousWeek}>
                <FoodUiIcon name="arrowLeft" />
                上一周
              </button>
              <button type="button" onClick={props.onFoodPlanCurrentWeek}>
                本周
              </button>
              <button type="button" onClick={props.onFoodPlanNextWeek}>
                下一周
                <FoodUiIcon name="arrowRight" />
              </button>
            </div>
            <ActionButton tone="primary" type="button" size="compact" className="recipe-plan-add-button food-plan-add-button" onClick={() => openPlanDialog()} disabled={props.isUpdatingPlan || props.foods.length === 0}>
              <FoodUiIcon name="plus" />
              加食物
            </ActionButton>
            <div className="recipe-plan-week food-plan-week">
              {foodPlanDays.map((day) => (
                <div key={day.date} className="recipe-plan-day expanded">
                  <button className="recipe-plan-day-head" type="button">
                    <strong>{day.label}</strong>
                    <span>{day.items.length > 0 ? `${day.items.length} 项` : '未安排'}</span>
                  </button>
                  {day.items.length > 0 ? (
                    day.items.map((item) => (
                      <article key={item.id} className="recipe-plan-item" role="button" tabIndex={0} onClick={() => openPlanDetail(item)}>
                        <div className="recipe-plan-item-summary">
                          <strong>{item.food_name}</strong>
                          <span>{MEAL_TYPE_LABELS[item.meal_type]}{item.status === 'cooked' ? ' · 已完成' : ''}</span>
                        </div>
                        <button
                          className="recipe-plan-item-detail-button"
                          type="button"
                          aria-label={`${item.recipe_id ? '开始做' : '记到今天'}：${item.food_name}`}
                          disabled={props.isQuickAdding || item.status === 'cooked'}
                          onClick={(event) => {
                            event.stopPropagation();
                            void completePlanItem(item);
                          }}
                        >
                          <FoodUiIcon name={item.recipe_id ? 'bowl' : 'check'} />
                        </button>
                      </article>
                    ))
                  ) : (
                    <div className="recipe-plan-empty-row">未安排</div>
                  )}
                </div>
              ))}
            </div>
          </div>
          <div className="food-sidebar-section">
            <div className="food-sidebar-section-head">
              <strong>按场景探索</strong>
              <span>从食物场景标签中整理</span>
            </div>
            <div className="food-sidebar-scene-list" aria-label="按场景探索">
              {sceneCards.length > 0 ? (
                sceneCards.map((scene) => (
                  <button
                    key={scene.name}
                    className={sceneFilter === scene.name ? 'active' : ''}
                    type="button"
                    onClick={() => setSceneFilter(sceneFilter === scene.name ? 'all' : scene.name)}
                  >
                    <span className="food-sidebar-scene-thumb">
                      {scene.imageUrl ? <img src={`${API_BASE_URL}${scene.imageUrl}`} alt="" /> : <FoodUiIcon name="star" />}
                    </span>
                    <span className="food-sidebar-scene-copy">
                      <strong>{scene.name}</strong>
                      <span>{scene.description || (scene.count > 0 ? `${scene.count} 份食物` : '推荐场景')}</span>
                    </span>
                  </button>
                ))
              ) : (
                <span className="food-sidebar-empty">暂无场景标签</span>
              )}
            </div>
          </div>
        </aside>
      </div>
      </div>

      {detailFood && (() => {
        const usage = getMealUsage(detailFood, props.mealLogs);
        const expiry = describeExpiry(detailFood);
        const normalizedType = normalizeFoodType(detailFood);
        const status = getFoodStatus(detailFood, usage, expiry, props.recipes);
        const factRows = getFoodFactRows(detailFood, usage, expiry);
        const history = getFoodMealHistory(detailFood, props.mealLogs);
        const relation = buildFoodRelationViewModelFromRecipeCards(detailFood, recipeCards, props.mealLogs);
        const linkedRecipeCard = relation.linkedRecipeCard;
        const recipe = linkedRecipeCard?.recipe ?? (detailFood.recipe_id ? props.recipes.find((item) => item.id === detailFood.recipe_id) ?? null : null);
        const cover = getFoodCover(detailFood, props.recipes);
        const detailMealOptions = detailFood.suitable_meal_types.length > 0
          ? MEAL_OPTIONS.filter((meal) => detailFood.suitable_meal_types.includes(meal.value))
          : MEAL_OPTIONS;

        return (
          <div className="workspace-overlay-root">
            <div className="workspace-overlay-backdrop" onClick={() => setDetailFoodId(null)} />
            <WorkspaceDrawer
              eyebrow={FOOD_TYPE_LABELS[normalizedType]}
              title={detailFood.name}
              description={detailFood.routine_note || detailFood.notes || getFoodSceneTags(detailFood).join('、') || detailFood.scene || '这份食物还没有补充决策备注。'}
              className="food-detail-drawer"
              onClose={() => setDetailFoodId(null)}
            >
              <div className="food-detail-hero">
                <div className="food-detail-cover">
                  {cover ? <img src={resolveFoodAssetUrl(cover)} alt={detailFood.name} /> : <span>{detailFood.name.slice(0, 4)}</span>}
                </div>
                <div className="food-detail-status-row">
                  <span className={`food-card-status tone-${status.tone}`}>
                    <strong>{status.label}</strong>
                    <small>{status.detail}</small>
                  </span>
                  <Badge>{detailFood.favorite ? '已收藏' : getRepurchaseLabel(detailFood)}</Badge>
                </div>
              </div>

              <section className="food-detail-section">
                <div className="food-detail-section-head">
                  <h4>决策信息</h4>
                  <span>{getFoodAudienceText(detailFood, props.mealLogs)}</span>
                </div>
                <div className="food-detail-facts">
                  {factRows.map((row) => (
                    <div key={row.label}>
                      <span>{row.label}</span>
                      <strong>{row.value}</strong>
                    </div>
                  ))}
                </div>
                <div className="food-detail-context">
                  <div>
                    <span>适合餐别</span>
                    <strong>{detailFood.suitable_meal_types.map((meal) => MEAL_TYPE_LABELS[meal]).join('、') || '未设置'}</strong>
                  </div>
                  <div>
                    <span>适合场景</span>
                    <strong>{getFoodSceneTags(detailFood).join('、') || detailFood.scene || detailFood.category || '未设置'}</strong>
                  </div>
                </div>
              </section>

              <section className="food-detail-section">
                <div className="food-detail-section-head">
                  <h4>关系面板</h4>
                  <span>{relation.summary}</span>
                </div>
                <div className="food-detail-facts">
                  {relation.relationFacts.map((row) => (
                    <div key={row.label}>
                      <span>{row.label}</span>
                      <strong>{row.value}</strong>
                    </div>
                  ))}
                </div>
                <p className="food-detail-empty">{relation.detail}</p>
              </section>

              {recipe && (
                <section className="food-detail-section food-detail-recipe">
                  <div className="food-detail-section-head">
                    <h4>关联菜谱</h4>
                    <span>{linkedRecipeCard ? linkedRecipeCard.availabilityLabel : `${recipe.ingredient_items.length} 个原料 · ${recipe.steps.length} 个步骤`}</span>
                  </div>
                  <strong>{recipe.title}</strong>
                  <p>{linkedRecipeCard?.availabilityDetail || recipe.tips || '这份家常菜已经和菜谱关联，可以去菜谱页查看做法和复做记录。'}</p>
                  {linkedRecipeCard && (
                    <div className="food-detail-ingredient-grid">
                      {linkedRecipeCard.ingredientAvailability.slice(0, 6).map((item) => (
                        <div key={item.item.id} className={item.ready ? 'ready' : 'missing'}>
                          <span>{item.item.ingredient_name}</span>
                          <strong>{item.ready ? '已有' : `缺 ${item.missingQuantity}${item.unit}`}</strong>
                        </div>
                      ))}
                    </div>
                  )}
                  {relation.shortagePreview.length > 0 && (
                    <div className="food-detail-shortages">
                      <span>缺料</span>
                      {relation.shortagePreview.map((item) => <Badge key={item}>{item}</Badge>)}
                    </div>
                  )}
                  <ActionButton tone="secondary" size="compact" type="button" onClick={props.onOpenRecipes}>
                    看菜谱
                  </ActionButton>
                </section>
              )}

              {isOutsideFood(detailFood) && (
                <section className="food-detail-section">
                  <div className="food-detail-section-head">
                    <h4>复吃判断</h4>
                    <span>{getRepurchaseLabel(detailFood)}</span>
                  </div>
                  <div className="food-detail-context">
                    <div><span>{normalizedType === 'takeout' ? '店铺' : '餐厅'}</span><strong>{detailFood.source_name || '未记录'}</strong></div>
                    <div><span>历史记录</span><strong>{usage.count > 0 ? `${usage.count} 次` : '还未记录'}</strong></div>
                    <div><span>最近一次</span><strong>{relation.lastMealLog ? formatDate(relation.lastMealLog.date) : '还没有'}</strong></div>
                    <div><span>价格 / 人均</span><strong>{detailFood.price == null ? '未记录' : `¥${detailFood.price}`}</strong></div>
                    <div><span>评分</span><strong>{detailFood.rating == null ? '未评分' : `${detailFood.rating} 分`}</strong></div>
                  </div>
                </section>
              )}

              {isReadyLikeFood(detailFood) && (
                <section className="food-detail-section">
                  <div className="food-detail-section-head">
                    <h4>库存与到期</h4>
                    <span>{expiry ?? '未记录到期'}</span>
                  </div>
                  <div className="food-detail-context">
                    <div><span>剩余库存</span><strong>{detailFood.stock_quantity == null ? '未记录' : `${detailFood.stock_quantity}${detailFood.stock_unit}`}</strong></div>
                    <div><span>购买渠道</span><strong>{detailFood.purchase_source || detailFood.source_name || '未记录'}</strong></div>
                    <div><span>到期日期</span><strong>{detailFood.expiry_date ? formatDate(detailFood.expiry_date) : '未记录'}</strong></div>
                  </div>
                  {detailFood.stock_quantity == null && <p className="food-detail-empty">这份成品速食还没有库存数量，补齐后会更容易判断是否适合作为今天的备用餐。</p>}
                </section>
              )}

              <section className="food-detail-section">
                <div className="food-detail-section-head">
                  <h4>加入今天</h4>
                  <span>快速记录一餐</span>
                </div>
                <div className="food-detail-meal-actions">
                  {detailMealOptions.map((item) => (
                    <button key={item.value} type="button" disabled={props.isQuickAdding} onClick={() => void quickAdd(detailFood, item.value)}>
                      + {item.label}
                    </button>
                  ))}
                </div>
              </section>

              <section className="food-detail-section">
                <div className="food-detail-section-head">
                  <h4>最近吃过</h4>
                  <span>{usage.count > 0 ? `共 ${usage.count} 次 · 最近 ${relation.lastMealLog ? formatDate(relation.lastMealLog.date) : '未知'}` : '还没有记录'}</span>
                </div>
                {history.length > 0 ? (
                  <div className="food-detail-history">
                    {history.map(({ log, entry }) => (
                      <article key={log.id}>
                        <div>
                          <strong>{formatDate(log.date)} · {MEAL_TYPE_LABELS[log.meal_type]}</strong>
                          <span>{entry?.servings ?? 1} 份{entry?.note ? ` · ${entry.note}` : ''}</span>
                        </div>
                        <small>{log.mood || log.notes || '已记录'}</small>
                      </article>
                    ))}
                  </div>
                ) : (
                  <p className="food-detail-empty">还没有吃过记录。加入今天后，这里会开始沉淀复吃历史。</p>
                )}
              </section>

              <div className="workspace-overlay-actions food-detail-actions">
                <ActionButton tone="primary" type="button" onClick={() => void quickAdd(detailFood, getDefaultMealType(detailFood))}>
                  {getPrimaryFoodActionLabel(detailFood)}
                </ActionButton>
                <ActionButton tone="secondary" type="button" onClick={() => openEdit(detailFood)}>
                  {getSecondaryFoodActionLabel(detailFood)}
                </ActionButton>
                <ActionButton tone="secondary" type="button" onClick={() => openPlanDialog(detailFood)}>
                  加入菜单
                </ActionButton>
                <ActionButton tone="secondary" type="button" onClick={props.onOpenLogs}>
                  完整记一餐
                </ActionButton>
              </div>
            </WorkspaceDrawer>
          </div>
        );
      })()}

      {isPlanDialogOpen && (
        <div className="workspace-overlay-root">
          <div className="workspace-overlay-backdrop" onClick={closePlanDialog} />
          <WorkspaceModal
            title="加食物到菜单"
            description="选择日期和餐次后加入当前周菜单。"
            eyebrow="菜单计划"
            onClose={closePlanDialog}
            className="recipe-plan-modal food-plan-modal"
          >
            <form className="recipe-plan-dialog-form" onSubmit={submitPlanItem}>
              {selectedPlanFood ? (
                <div className="recipe-plan-dialog-hero">
                  <div className="recipe-plan-selected-cover">
                    {getFoodCover(selectedPlanFood, props.recipes) ? (
                      <img src={resolveFoodAssetUrl(getFoodCover(selectedPlanFood, props.recipes) ?? '')} alt={selectedPlanFood.name} />
                    ) : (
                      <div className="recipe-plan-cover-empty">{selectedPlanFood.name.slice(0, 2)}</div>
                    )}
                  </div>
                  <div className="recipe-plan-selected-copy">
                    <span className="recipe-plan-dialog-kicker">即将加入</span>
                    <strong>{selectedPlanFood.name}</strong>
                    <div className="recipe-plan-selected-meta">
                      <span>
                        <FoodUiIcon name="home" />
                        {FOOD_TYPE_LABELS[normalizeFoodType(selectedPlanFood)]}
                      </span>
                      <span>
                        <FoodUiIcon name="cloche" />
                        {selectedPlanFood.source_name || selectedPlanFood.purchase_source || (normalizeFoodType(selectedPlanFood) === 'selfMade' ? '家庭厨房' : selectedPlanFood.category || '常吃食物')}
                      </span>
                      <span>
                        <FoodUiIcon name={selectedPlanFood.recipe_id ? 'bookOpen' : 'clipboard'} />
                        {selectedPlanFood.recipe_id ? '关联菜谱' : '可直接记录'}
                      </span>
                    </div>
                  </div>
                  <button className="recipe-plan-change-food" type="button" onClick={clearPlanFoodSelection}>
                    修改
                  </button>
                  <FoodUiIcon name="cloche" className="recipe-plan-selected-ornament" />
                </div>
              ) : (
                <div className="recipe-plan-picker">
                  <label htmlFor="food-plan-search">选择食物</label>
                  <div className="recipe-plan-combobox">
                    <FoodUiIcon name="search" />
                    <input
                      id="food-plan-search"
                      className="recipe-plan-search-input"
                      value={planFoodSearch}
                      placeholder="搜索食物、来源、场景或备注"
                      onChange={(event) => setPlanFoodSearch(event.target.value)}
                    />
                  </div>
                  <div className="recipe-plan-option-panel">
                    {planFoodOptions.length > 0 ? (
                      planFoodOptions.map((food) => {
                        const cover = getFoodCover(food, props.recipes);
                        return (
                          <button
                            key={food.id}
                            type="button"
                            className="recipe-plan-option"
                            onClick={() => {
                              setPlanForm((current) => ({ ...current, foodId: food.id, mealType: getDefaultMealType(food) }));
                              setPlanFoodSearch(food.name);
                            }}
                          >
                            <span className="recipe-plan-option-cover recipe-work-cover">
                              {cover ? <img src={resolveFoodAssetUrl(cover)} alt="" /> : <span>{food.name.slice(0, 2)}</span>}
                            </span>
                            <span>
                              <strong>{food.name}</strong>
                              <small>{[FOOD_TYPE_LABELS[normalizeFoodType(food)], food.source_name || food.purchase_source || food.category, food.recipe_id ? '可开始做' : '可记到今天'].filter(Boolean).join(' · ')}</small>
                            </span>
                            <Badge className="recipe-plan-option-status">{MEAL_TYPE_LABELS[getDefaultMealType(food)]}</Badge>
                          </button>
                        );
                      })
                    ) : (
                      <div className="recipe-plan-option-empty">没有找到匹配的食物</div>
                    )}
                  </div>
                </div>
              )}

              <div className="recipe-plan-form-row">
                <label className="recipe-plan-date-field">
                  <span>计划日期</span>
                  <div className="recipe-plan-date-strip" role="radiogroup" aria-label="计划日期">
                    {planDateOptions.map((date) => {
                      const dateParts = getFoodPlanDateParts(date);
                      return (
                        <button
                          key={date}
                          type="button"
                          className={planForm.planDate === date ? 'active' : ''}
                          aria-pressed={planForm.planDate === date}
                          onClick={() => setPlanForm({ ...planForm, planDate: date })}
                        >
                          <span>{date === todayDate ? '今天' : dateParts.weekday}</span>
                          <strong>{dateParts.month}/{dateParts.day}</strong>
                        </button>
                      );
                    })}
                  </div>
                </label>
                <label className="recipe-plan-meal-field">
                  <span>餐次</span>
                  <div className="recipe-plan-meal-segment" role="radiogroup" aria-label="餐次">
                    {MEAL_OPTIONS.map((item) => (
                      <button
                        key={item.value}
                        type="button"
                        className={planForm.mealType === item.value ? 'active' : ''}
                        aria-pressed={planForm.mealType === item.value}
                        onClick={() => setPlanForm({ ...planForm, mealType: item.value })}
                      >
                        {item.label}
                      </button>
                    ))}
                  </div>
                </label>
              </div>
              <label className="recipe-plan-note-field">
                <span>备注</span>
                <input className="text-input" value={planForm.note} placeholder="比如：少油、常点套餐、提前解冻" onChange={(event) => setPlanForm({ ...planForm, note: event.target.value })} />
              </label>
              <div className="workspace-overlay-actions">
                <ActionButton tone="primary" type="submit" disabled={props.isUpdatingPlan || !planForm.foodId}>
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

      {activePlanDetailItem && (
        <FoodPlanDetailModal
          item={activePlanDetailItem}
          food={activePlanDetailFood}
          recipes={props.recipes}
          form={planDetailForm}
          isEditing={isPlanDetailEditing}
          isUpdatingPlan={props.isUpdatingPlan}
          isCompleting={props.isQuickAdding}
          onClose={closePlanDetail}
          onChangeForm={setPlanDetailForm}
          onEditingChange={setIsPlanDetailEditing}
          onResetEdit={resetPlanDetailForm}
          onSubmit={submitPlanDetail}
          onComplete={() => void completePlanItem(activePlanDetailItem)}
          onDelete={() => void deletePlanDetail(activePlanDetailItem)}
          resolveAssetUrl={resolveFoodAssetUrl}
        />
      )}

      {isSceneManagerOpen && !sceneFormMode && (
        <div className="workspace-overlay-root">
          <div className="workspace-overlay-backdrop" onClick={() => setIsSceneManagerOpen(false)} />
          <WorkspaceModal
            title="场景管理"
            description="新增常用食物场景，或整理不再使用的场景入口。"
            eyebrow="食物场景"
            onClose={() => setIsSceneManagerOpen(false)}
            className="food-scene-manager-modal"
          >
            <div className="food-scene-manager">
              <div className="food-scene-manager-toolbar">
                <div>
                  <strong>{sceneCards.length} 个场景</strong>
                  <span>整理食物库里的场景入口和封面。</span>
                </div>
                <ActionButton tone="primary" type="button" onClick={() => openCreateScene()}>
                  <FoodUiIcon name="plus" />
                  <span>新建场景</span>
                </ActionButton>
              </div>
              <div className="food-scene-list">
                {sceneCards.length > 0 ? (
                  sceneCards.map((scene) => (
                    <article key={scene.name} className="food-scene-row">
                      <div className="food-scene-row-thumb">
                        {scene.imageUrl ? <img src={`${API_BASE_URL}${scene.imageUrl}`} alt="" /> : <FoodUiIcon name="star" />}
                      </div>
                      <div className="food-scene-row-copy">
                        <div className="food-scene-row-titleline">
                          <strong>{scene.name}</strong>
                          <span>{scene.id ? '自定义' : '推荐'}</span>
                        </div>
                        <p>{scene.description || `${scene.count} 份食物`}</p>
                      </div>
                      <div className="food-scene-row-meta">{scene.count} 份食物</div>
                      <div className="food-scene-row-actions">
                        <button type="button" onClick={() => openEditScene(scene)}>{scene.id ? '编辑' : '创建'}</button>
                        {scene.id && <button type="button" disabled={props.isUpdatingScene} onClick={() => void deleteScene(scene.id)}>删除</button>}
                      </div>
                    </article>
                  ))
                ) : (
                  <p className="subtle">暂无可管理场景。</p>
                )}
              </div>
            </div>
          </WorkspaceModal>
        </div>
      )}

      {sceneFormMode && (
        <div className="workspace-overlay-root">
          <div className="workspace-overlay-backdrop" onClick={closeSceneForm} />
          <WorkspaceModal
            title={sceneFormMode === 'edit' ? '编辑场景' : '新建场景'}
            description="填写名称和说明后，可生成一张统一风格的食物场景封面。"
            eyebrow="食物场景"
            onClose={closeSceneForm}
            className="food-scene-form-modal"
          >
            <form className="food-scene-form" onSubmit={submitScene}>
              <div className="food-scene-form-fields">
                <label className="food-scene-input-field">
                  <span>场景名称</span>
                  <input className="text-input" value={sceneDraft.name} placeholder="场景名称，例如：加班晚餐" onChange={(event) => setSceneDraft({ ...sceneDraft, name: event.target.value })} />
                </label>
                <label className="food-scene-input-field">
                  <span>说明</span>
                  <input className="text-input" value={sceneDraft.description} placeholder="说明，例如：快手、省心、适合工作日" onChange={(event) => setSceneDraft({ ...sceneDraft, description: event.target.value })} />
                </label>
                <label className="food-scene-input-field">
                  <span>封面描述</span>
                  <input className="text-input" value={sceneDraft.imagePrompt} placeholder="图片描述，例如：一桌轻食晚餐" onChange={(event) => setSceneDraft({ ...sceneDraft, imagePrompt: event.target.value })} />
                </label>
                <div className="food-scene-cover-editor">
                  <div className={sceneDraft.imageAssetUrl ? 'food-scene-cover-preview has-image' : 'food-scene-cover-preview'}>
                    {sceneDraft.imageAssetUrl ? (
                      <img src={resolveFoodAssetUrl(sceneDraft.imageAssetUrl)} alt={sceneDraft.name || '场景封面'} />
                    ) : (
                      <FoodUiIcon name="star" />
                    )}
                  </div>
                  <div className="food-scene-cover-copy">
                    <strong>场景封面</strong>
                    <span>{sceneDraft.imageAssetUrl ? '已生成封面，可重新生成或移除。' : '根据名称、说明和图片描述生成统一风格封面。'}</span>
                  </div>
                  <div className="food-scene-cover-actions">
                    <button
                      type="button"
                      disabled={sceneImageState.isGenerating || !sceneDraft.name.trim()}
                      onClick={() => void generateFoodSceneImage()}
                    >
                      <FoodUiIcon name="star" />
                      {sceneImageState.isGenerating ? '生成中...' : sceneDraft.imageAssetUrl ? '重新生成' : '生成封面'}
                    </button>
                    {sceneDraft.imageAssetUrl && (
                      <button className="danger" type="button" onClick={() => setSceneDraft({ ...sceneDraft, imageAssetId: undefined, imageAssetUrl: undefined })}>
                        移除
                      </button>
                    )}
                  </div>
                </div>
                {!sceneDraft.name.trim() && <small className="food-scene-image-hint">填写场景名称后可生成封面</small>}
                {sceneImageState.errorMessage && <p className="image-composer-error recipe-scene-error">{sceneImageState.errorMessage}</p>}
              </div>
              <div className="workspace-overlay-actions food-scene-form-actions">
                <ActionButton tone="secondary" type="button" onClick={closeSceneForm}>
                  取消
                </ActionButton>
                <ActionButton tone="primary" type="submit" disabled={props.isUpdatingScene || sceneImageState.isGenerating || !sceneDraft.name.trim()}>
                  {sceneFormMode === 'edit' ? '保存场景' : '添加场景'}
                </ActionButton>
              </div>
            </form>
          </WorkspaceModal>
        </div>
      )}
    </main>
  );
}
