import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode, type UIEvent } from 'react';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { API_BASE_URL, api } from './api/client';
import type {
  AiMode,
  Food,
  ImageInputValue,
  Ingredient,
  FoodRecommendations,
  FoodType,
  FoodPlanItem,
  IngredientExpiryMode,
  InventoryItem,
  InventoryStatus,
  MealLog,
  MealType,
  Recipe,
  RecipeDiscovery,
  FoodScene,
  RecipeStats,
  ShoppingListItem,
} from './api/types';
import { useAuth } from './auth/AuthContext';
import { FoodPlanDetailModal, type FoodPlanDetailFormState } from './components/foods/FoodPlanDetailModal';
import { FoodWorkspace } from './components/foods/FoodWorkspace';
import { IngredientWorkspace } from './components/ingredients/IngredientWorkspace';
import {
  buildDisposableExpiredInventoryItems,
  buildIngredientSummaries,
} from './components/ingredients/workspaceModel';
import { LoginScreen } from './components/LoginScreen';
import { RecipeWorkspace } from './components/recipes/RecipeWorkspace';
import { addDateKeyDays, getRecipeWeekRange } from './components/recipes/workspaceModel';
import {
  ActionButton,
  Avatar,
  Badge,
  EmptyState,
  ImageComposer,
  PageHeader,
  SectionHeading,
  SegmentedTabs,
  WorkspaceSubpageHeader,
  WorkspaceSubpageShell,
  WorkspaceModal,
  WorkspaceToolbar,
} from './components/ui-kit';
import {
  AI_MODE_LABELS,
  FOOD_TYPE_LABELS,
  INVENTORY_STATUS_LABELS,
  MEAL_TYPE_LABELS,
  buildIngredientPlaceholderSvg,
  buildInventoryAlerts,
  emptyImages,
  formatDate,
  formatDateTime,
  formatRelativeDays,
  getFoodCover,
  splitTags,
  todayKey,
} from './lib/ui';
import {
  type AiRenderPayload,
  generateImageFromText,
  getMediaIds,
  regenerateImageFromReference,
  uploadReferenceAndGenerateImage,
} from './lib/aiImages';

type TabKey = 'home' | 'foods' | 'recipes' | 'ingredients' | 'logs' | 'ai' | 'family';
type FoodWorkspaceView = 'list' | 'create';
type FamilyOverlayMode = 'invite' | null;
type IngredientNavigationRequest = {
  view: 'catalog' | 'detail';
  ingredientId?: string;
  requestId: number;
};

type FoodFormState = {
  name: string;
  type: FoodType;
  category: string;
  flavorTags: string;
  sourceName: string;
  scene: string;
  notes: string;
  favorite: boolean;
  recipeId: string;
  images: ImageInputValue;
};

type LocalMealFoodEntry = {
  food_id: string;
  servings: number;
  note: string;
};

type MealFormState = {
  date: string;
  mealType: MealType;
  notes: string;
  mood: string;
  photos: ImageInputValue;
};

type HomeRestockFormState = {
  ingredientId: string;
  ingredientQuery: string;
  quantity: string;
  unit: string;
  purchaseDate: string;
  storageLocation: string;
  expiryInputMode: IngredientExpiryMode;
  expiryDays: string;
  expiryDate: string;
  status: InventoryStatus;
  notes: string;
};

type HomePlanAddFormState = {
  planDate: string;
  mealType: MealType;
  note: string;
};

type InviteFormState = {
  username: string;
  displayName: string;
  password: string;
  role: 'Owner' | 'Member';
  email: string;
};

type DashboardExpiryTodoInventoryItem = InventoryItem & { daysLeft: number };

type DashboardTodoItem =
  | {
      type: 'expiry';
      id: string;
      title: string;
      description: string;
      status: string;
      done: false;
      dateLabel: string;
      icon: DashboardIconName;
      item: DashboardExpiryTodoInventoryItem;
    }
  | {
      type: 'shopping';
      id: string;
      title: string;
      description: string;
      status: string;
      done: false;
      dateLabel: string;
      icon: DashboardIconName;
      item: ShoppingListItem;
    }
  | {
      type: 'meal';
      id: string;
      title: string;
      description: string;
      status: string;
      done: true;
      dateLabel: string;
      icon: DashboardIconName;
      item: MealLog;
    };

type ShellIconName =
  | 'logo'
  | 'home'
  | 'foods'
  | 'recipes'
  | 'ingredients'
  | 'logs'
  | 'ai'
  | 'family'
  | 'panel-open'
  | 'panel-close'
  | 'logout';

type DashboardIconName =
  | 'leaf'
  | 'bell'
  | 'cart'
  | 'pot'
  | 'plus'
  | 'receipt'
  | 'list'
  | 'chevron'
  | 'arrow-left'
  | 'arrow-right'
  | 'edit'
  | 'check'
  | 'circle'
  | 'calendar'
  | 'flame';

const DASHBOARD_PLAN_MEAL_TYPES: MealType[] = ['breakfast', 'lunch', 'dinner', 'snack'];
const DASHBOARD_TODO_PAGE_SIZE = 4;

function IconBase(props: { children: ReactNode }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {props.children}
    </svg>
  );
}

function ShellIcon(props: { name: ShellIconName }) {
  switch (props.name) {
    case 'logo':
      return (
        <IconBase>
          <path d="M6 10h12" />
          <path d="M7 10v3a5 5 0 0 0 10 0v-3" />
          <path d="M17 11h1a2 2 0 0 1 0 4h-1" />
          <path d="M9 7V5" />
          <path d="M12 7V4" />
          <path d="M15 7V5" />
        </IconBase>
      );
    case 'home':
      return (
        <IconBase>
          <path d="M4 10.5 12 4l8 6.5" />
          <path d="M6.5 9.5V20h11V9.5" />
          <path d="M10 20v-5h4v5" />
        </IconBase>
      );
    case 'foods':
      return (
        <IconBase>
          <path d="M5 13h14" />
          <path d="M6 13a6 6 0 0 0 12 0" />
          <path d="M9 4.5c0 1-1 1.4-1 2.4S9 8.5 9 9.5" />
          <path d="M13 4.5c0 1-1 1.4-1 2.4s1 1.6 1 2.6" />
        </IconBase>
      );
    case 'recipes':
      return (
        <IconBase>
          <path d="M7 5.5h10a2 2 0 0 1 2 2V19H9a3 3 0 0 0-3 3" />
          <path d="M7 5.5V22" />
          <path d="M10 9h6" />
          <path d="M10 13h6" />
        </IconBase>
      );
    case 'ingredients':
      return (
        <IconBase>
          <path d="M19 4c-6 1-10 5-11 11" />
          <path d="M7 20c-2-4-2-8 1-11s7-4 11-5c1 4-1 8-4 11s-7 5-8 5Z" />
        </IconBase>
      );
    case 'logs':
      return (
        <IconBase>
          <rect x="6" y="5" width="12" height="15" rx="2" />
          <path d="M9 5.5h6" />
          <path d="M9 10h6" />
          <path d="M9 14h6" />
        </IconBase>
      );
    case 'ai':
      return (
        <IconBase>
          <path d="M12 3l1.6 4.4L18 9l-4.4 1.6L12 15l-1.6-4.4L6 9l4.4-1.6L12 3Z" />
          <path d="M19 4v3" />
          <path d="M20.5 5.5h-3" />
          <path d="M18 16v2" />
          <path d="M19 17h-2" />
        </IconBase>
      );
    case 'family':
      return (
        <IconBase>
          <path d="M16 20v-1a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v1" />
          <circle cx="10" cy="8" r="3" />
          <path d="M20 20v-1a4 4 0 0 0-3-3.87" />
          <path d="M17 5.3a3 3 0 0 1 0 5.4" />
        </IconBase>
      );
    case 'panel-open':
      return (
        <IconBase>
          <path d="m9 6 6 6-6 6" />
        </IconBase>
      );
    case 'panel-close':
      return (
        <IconBase>
          <path d="m15 6-6 6 6 6" />
        </IconBase>
      );
    case 'logout':
      return (
        <IconBase>
          <path d="M10 7V5a1 1 0 0 1 1-1h7a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-7a1 1 0 0 1-1-1v-2" />
          <path d="M15 12H4" />
          <path d="m8 8-4 4 4 4" />
        </IconBase>
      );
  }
}

function DashboardIcon(props: { name: DashboardIconName }) {
  switch (props.name) {
    case 'leaf':
      return (
        <IconBase>
          <path d="M19 4c-6 1-10 5-11 11" />
          <path d="M7 20c-2-4-2-8 1-11s7-4 11-5c1 4-1 8-4 11s-7 5-8 5Z" />
        </IconBase>
      );
    case 'bell':
      return (
        <IconBase>
          <path d="M6 9a6 6 0 0 1 12 0c0 7 3 6 3 8H3c0-2 3-1 3-8" />
          <path d="M10 20a2 2 0 0 0 4 0" />
        </IconBase>
      );
    case 'cart':
      return (
        <IconBase>
          <path d="M5 5h2l1.5 10h8.5l2-7H8" />
          <circle cx="10" cy="19" r="1" />
          <circle cx="17" cy="19" r="1" />
        </IconBase>
      );
    case 'pot':
      return (
        <IconBase>
          <path d="M6 10h12" />
          <path d="M7 10v4a5 5 0 0 0 10 0v-4" />
          <path d="M17 12h1.5a2 2 0 0 1 0 4H17" />
          <path d="M10 7V5" />
          <path d="M14 7V5" />
        </IconBase>
      );
    case 'plus':
      return (
        <IconBase>
          <path d="M12 5v14" />
          <path d="M5 12h14" />
        </IconBase>
      );
    case 'receipt':
      return (
        <IconBase>
          <path d="M7 4h10v16l-2-1.2-2 1.2-2-1.2-2 1.2-2-1.2V4Z" />
          <path d="M10 9h4" />
          <path d="M10 13h4" />
        </IconBase>
      );
    case 'list':
      return (
        <IconBase>
          <path d="M9 7h10" />
          <path d="M9 12h10" />
          <path d="M9 17h10" />
          <path d="M5 7h.01" />
          <path d="M5 12h.01" />
          <path d="M5 17h.01" />
        </IconBase>
      );
    case 'chevron':
      return (
        <IconBase>
          <path d="m9 6 6 6-6 6" />
        </IconBase>
      );
    case 'arrow-left':
      return (
        <IconBase>
          <path d="m15 6-6 6 6 6" />
        </IconBase>
      );
    case 'arrow-right':
      return (
        <IconBase>
          <path d="m9 6 6 6-6 6" />
        </IconBase>
      );
    case 'edit':
      return (
        <IconBase>
          <path d="M12 20h9" />
          <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4 11.5-11.5Z" />
        </IconBase>
      );
    case 'check':
      return (
        <IconBase>
          <path d="m7 12 3 3 7-7" />
        </IconBase>
      );
    case 'circle':
      return (
        <IconBase>
          <circle cx="12" cy="12" r="8" />
        </IconBase>
      );
    case 'calendar':
      return (
        <IconBase>
          <path d="M7 3v4" />
          <path d="M17 3v4" />
          <rect x="4" y="6" width="16" height="14" rx="2" />
          <path d="M8 11h8" />
        </IconBase>
      );
    case 'flame':
      return (
        <IconBase>
          <path d="M12 22c4 0 7-3 7-7 0-3-2-5-4-7 .2 2-1 3-2 3-1.5 0-2.5-1.4-2-4-3 2-5 5-5 8 0 4 2 7 6 7Z" />
        </IconBase>
      );
  }
}

function DashboardMealIcon(props: { mealType: MealType }) {
  switch (props.mealType) {
    case 'breakfast':
      return (
        <IconBase>
          <circle cx="12" cy="12" r="3.2" />
          <path d="M12 3.5v2" />
          <path d="M12 18.5v2" />
          <path d="M3.5 12h2" />
          <path d="M18.5 12h2" />
          <path d="m6 6 1.4 1.4" />
          <path d="m16.6 16.6 1.4 1.4" />
          <path d="m18 6-1.4 1.4" />
          <path d="m7.4 16.6-1.4 1.4" />
        </IconBase>
      );
    case 'lunch':
      return (
        <IconBase>
          <path d="M5 12h14" />
          <path d="M7 12a5 5 0 0 0 10 0" />
          <path d="M9 8c0-1 1-1.4 1-2.4" />
          <path d="M13 8c0-1 1-1.4 1-2.4" />
          <path d="M8 17h8" />
        </IconBase>
      );
    case 'dinner':
      return (
        <IconBase>
          <path d="M18 14.5A6.5 6.5 0 0 1 9.5 6a7 7 0 1 0 8.5 8.5Z" />
          <path d="M16.5 5.5h.01" />
          <path d="M19 8h.01" />
        </IconBase>
      );
    case 'snack':
      return (
        <IconBase>
          <path d="M12 7c3 0 5 2.3 5 5.8 0 4.2-2.2 7-5 7s-5-2.8-5-7C7 9.3 9 7 12 7Z" />
          <path d="M12 7c.2-2 1.3-3.2 3.2-3.6" />
          <path d="M10 5.5c-1.2-.8-2.4-.9-3.7-.3" />
        </IconBase>
      );
  }
}

const SIDEBAR_COLLAPSED_KEY = 'culina-large-shell-sidebar-collapsed-v3';

const NAV_ITEMS: Array<{ key: TabKey; label: string; icon: ShellIconName }> = [
  { key: 'home', label: '首页', icon: 'home' },
  { key: 'foods', label: '食物', icon: 'foods' },
  { key: 'recipes', label: '菜谱', icon: 'recipes' },
  { key: 'ingredients', label: '食材', icon: 'ingredients' },
  { key: 'logs', label: '记录', icon: 'logs' },
  { key: 'ai', label: 'AI', icon: 'ai' },
  { key: 'family', label: '我的家庭', icon: 'family' },
];

type ImageGenerationUiState = {
  isGenerating: boolean;
  errorMessage: string | null;
};

const IDLE_IMAGE_GENERATION_STATE: ImageGenerationUiState = {
  isGenerating: false,
  errorMessage: null,
};

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

function buildFoodImagePayload(form: FoodFormState, recipes: Recipe[]): AiRenderPayload {
  const linkedRecipe = recipes.find((recipe) => recipe.id === form.recipeId);
  return {
    entity_type: 'food',
    title: form.name.trim() || linkedRecipe?.title || form.sourceName.trim() || '家庭食物',
    category: form.category.trim(),
    notes: form.notes.trim(),
    tags: splitTags(form.flavorTags),
    scene: form.scene.trim(),
    ingredient_names: linkedRecipe?.ingredient_items.map((item) => item.ingredient_name).filter(Boolean) ?? [],
  };
}

function buildMealImagePayload(
  form: MealFormState,
  entries: LocalMealFoodEntry[],
  foods: Array<{ id: string; name: string }>
): AiRenderPayload {
  return {
    entity_type: 'meal_log',
    title: `${MEAL_TYPE_LABELS[form.mealType]}餐食`,
    notes: form.notes.trim(),
    meal_type: form.mealType,
    food_names: entries
      .map((entry) => foods.find((food) => food.id === entry.food_id)?.name)
      .filter((name): name is string => Boolean(name)),
  };
}

function defaultSidebarCollapsed() {
  const cached = localStorage.getItem(SIDEBAR_COLLAPSED_KEY);
  if (cached !== null) {
    return cached === '1';
  }
  return false;
}

function dateKeyTime(date: string) {
  const [year, month, day] = date.slice(0, 10).split('-').map(Number);
  return new Date(year, (month || 1) - 1, day || 1).getTime();
}

function getExpiryDaysLeft(expiryDate: string, referenceDate: string) {
  return Math.round((dateKeyTime(expiryDate) - dateKeyTime(referenceDate)) / (1000 * 60 * 60 * 24));
}

function getDashboardExpiryBadge(daysLeft: number) {
  if (daysLeft < 0) {
    return { label: `已过期${Math.abs(daysLeft)}天`, className: 'dashboard-expiry-badge dashboard-expiry-badge-expired' };
  }
  if (daysLeft === 0) {
    return { label: '今日过期', className: 'dashboard-expiry-badge dashboard-expiry-badge-today' };
  }
  if (daysLeft <= 3) {
    return { label: `还有${daysLeft}天过期`, className: 'dashboard-expiry-badge dashboard-expiry-badge-soon' };
  }
  return { label: `还有${daysLeft}天过期`, className: 'dashboard-expiry-badge dashboard-expiry-badge-later' };
}

function formatDashboardPlanRange(range: { start: string; end: string }) {
  const format = (dateKey: string) => {
    const [, month, day] = dateKey.split('-');
    return `${Number(month)}月${Number(day)}日`;
  };
  return `${format(range.start)} - ${format(range.end)}`;
}

function shiftDateKey(dateKey: string, offsetDays: number) {
  const [year, month, day] = dateKey.split('-').map(Number);
  const base = new Date(year, (month || 1) - 1, day || 1);
  base.setDate(base.getDate() + offsetDays);
  const nextYear = base.getFullYear();
  const nextMonth = `${base.getMonth() + 1}`.padStart(2, '0');
  const nextDay = `${base.getDate()}`.padStart(2, '0');
  return `${nextYear}-${nextMonth}-${nextDay}`;
}

function resolveInventoryStatusForStorage(storageLocation: string): InventoryStatus {
  return storageLocation.trim() === '冷冻' ? 'frozen' : 'fresh';
}

function resolveExpiryDateFromDays(purchaseDate: string, expiryDays: string) {
  const safeDays = Number(expiryDays);
  if (!purchaseDate || !Number.isFinite(safeDays) || safeDays <= 0) {
    return '';
  }
  return shiftDateKey(purchaseDate, safeDays);
}

function parsePositiveNumber(value: string) {
  const numeric = Number(value.trim());
  return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
}

function findShoppingIngredient(item: ShoppingListItem, ingredients: Ingredient[]) {
  const title = item.title.trim();
  return (
    ingredients.find((ingredient) => ingredient.name === title) ??
    ingredients.find((ingredient) => title.includes(ingredient.name) || ingredient.name.includes(title)) ??
    null
  );
}

function buildHomeRestockForm(item: ShoppingListItem, ingredients: Ingredient[]): HomeRestockFormState {
  const ingredient = findShoppingIngredient(item, ingredients);
  const purchaseDate = todayKey();
  const expiryInputMode = ingredient?.default_expiry_mode ?? 'none';
  const expiryDays =
    expiryInputMode === 'days' && ingredient?.default_expiry_days !== null && ingredient?.default_expiry_days !== undefined
      ? String(ingredient.default_expiry_days)
      : '';
  const storageLocation = ingredient?.default_storage || '冷藏';
  return {
    ingredientId: ingredient?.id ?? '',
    ingredientQuery: ingredient?.name ?? item.title,
    quantity: String(item.quantity || 1),
    unit: item.unit || ingredient?.default_unit || '个',
    purchaseDate,
    storageLocation,
    expiryInputMode,
    expiryDays,
    expiryDate: expiryInputMode === 'days' ? resolveExpiryDateFromDays(purchaseDate, expiryDays) : '',
    status: resolveInventoryStatusForStorage(storageLocation),
    notes: item.reason ? `来自采购提醒：${item.reason}` : '来自首页采购提醒',
  };
}

function App() {
  const queryClient = useQueryClient();
  const { isAuthenticated, isLoading: authLoading, user, membership, logout } = useAuth();
  const [selectedRecipePlanDate, setSelectedRecipePlanDate] = useState(todayKey());
  const foodPlanWeekRange = useMemo(() => getRecipeWeekRange(selectedRecipePlanDate), [selectedRecipePlanDate]);
  const [activeTab, setActiveTab] = useState<TabKey>(() => {
    const cached = localStorage.getItem('culina-active-tab');
    return (cached as TabKey) || 'home';
  });
  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(defaultSidebarCollapsed);
  const [foodSearch, setFoodSearch] = useState('');
  const [foodTypeFilter, setFoodTypeFilter] = useState<'all' | FoodType>('all');
  const [aiMode, setAiMode] = useState<AiMode>('recommendation');
  const [aiPrompt, setAiPrompt] = useState('');
  const [aiFoodId, setAiFoodId] = useState('');
  const [selectedAiIngredientIds, setSelectedAiIngredientIds] = useState<string[]>([]);
  const [mealFoodEntries, setMealFoodEntries] = useState<LocalMealFoodEntry[]>([]);
  const [selectedParticipants, setSelectedParticipants] = useState<string[]>(user ? [user.id] : []);

  const [foodForm, setFoodForm] = useState<FoodFormState>({
    name: '',
    type: 'takeout',
    category: '',
    flavorTags: '',
    sourceName: '',
    scene: '',
    notes: '',
    favorite: false,
    recipeId: '',
    images: emptyImages(),
  });
  const [mealForm, setMealForm] = useState<MealFormState>({
    date: todayKey(),
    mealType: 'dinner',
    notes: '',
    mood: '满足',
    photos: emptyImages(),
  });
  const [foodImageState, setFoodImageState] = useState<ImageGenerationUiState>(IDLE_IMAGE_GENERATION_STATE);
  const [mealImageState, setMealImageState] = useState<ImageGenerationUiState>(IDLE_IMAGE_GENERATION_STATE);
  const [inviteForm, setInviteForm] = useState<InviteFormState>({
    username: '',
    displayName: '',
    password: 'Culina123!',
    role: 'Member',
    email: '',
  });
  const [foodWorkspaceView, setFoodWorkspaceView] = useState<FoodWorkspaceView>('list');
  const [familyOverlayMode, setFamilyOverlayMode] = useState<FamilyOverlayMode>(null);
  const [pendingRecipeCookId, setPendingRecipeCookId] = useState<string | null>(null);
  const [pendingFoodPlanCookItemId, setPendingFoodPlanCookItemId] = useState<string | null>(null);
  const [dashboardRecommendationPage, setDashboardRecommendationPage] = useState(0);
  const [selectedDashboardPlanDate, setSelectedDashboardPlanDate] = useState(todayKey());
  const [homePlanDetailItemId, setHomePlanDetailItemId] = useState<string | null>(null);
  const [isHomePlanAddDialogOpen, setIsHomePlanAddDialogOpen] = useState(false);
  const [homePlanAddFoodId, setHomePlanAddFoodId] = useState<string | null>(null);
  const [homePlanAddFoodSearch, setHomePlanAddFoodSearch] = useState('');
  const [homePlanAddForm, setHomePlanAddForm] = useState<HomePlanAddFormState>({
    planDate: todayKey(),
    mealType: 'dinner',
    note: '',
  });
  const [homePlanDetailForm, setHomePlanDetailForm] = useState<FoodPlanDetailFormState>({
    planDate: todayKey(),
    mealType: 'dinner',
    note: '',
  });
  const [isHomePlanDetailEditing, setIsHomePlanDetailEditing] = useState(false);
  const [visibleExpiryCount, setVisibleExpiryCount] = useState(10);
  const [visibleDashboardTodoCount, setVisibleDashboardTodoCount] = useState(DASHBOARD_TODO_PAGE_SIZE);
  const [ingredientNavigationRequest, setIngredientNavigationRequest] = useState<IngredientNavigationRequest | null>(null);
  const [homeExpiredDisposalIngredientId, setHomeExpiredDisposalIngredientId] = useState<string | null>(null);
  const [homeExpiryReviewItemId, setHomeExpiryReviewItemId] = useState<string | null>(null);
  const [homeRestockShoppingItemId, setHomeRestockShoppingItemId] = useState<string | null>(null);
  const [homeRestockForm, setHomeRestockForm] = useState<HomeRestockFormState | null>(null);
  const [homeMealDetailId, setHomeMealDetailId] = useState<string | null>(null);
  const ingredientNavigationRequestIdRef = useRef(0);

  useEffect(() => {
    localStorage.setItem('culina-active-tab', activeTab);
  }, [activeTab]);

  useEffect(() => {
    localStorage.setItem(SIDEBAR_COLLAPSED_KEY, sidebarCollapsed ? '1' : '0');
  }, [sidebarCollapsed]);

  useEffect(() => {
    setSelectedParticipants((current) => {
      const valid = current.filter((id) => membersQuery.data?.some((member) => member.id === id));
      return valid.length > 0 ? valid : user ? [user.id] : [];
    });
  }, [user?.id]);

  const familyQuery = useQuery({
    queryKey: ['family'],
    queryFn: api.getFamily,
    enabled: isAuthenticated,
  });
  const membersQuery = useQuery({
    queryKey: ['members'],
    queryFn: api.getMembers,
    enabled: isAuthenticated,
  });
  const ingredientsQuery = useQuery({
    queryKey: ['ingredients'],
    queryFn: api.getIngredients,
    enabled: isAuthenticated,
  });
  const inventoryQuery = useQuery({
    queryKey: ['inventory'],
    queryFn: api.getInventory,
    enabled: isAuthenticated,
  });
  const shoppingQuery = useQuery({
    queryKey: ['shopping-list'],
    queryFn: api.getShoppingList,
    enabled: isAuthenticated,
  });
  const recipesQuery = useQuery({
    queryKey: ['recipes'],
    queryFn: api.getRecipes,
    enabled: isAuthenticated,
  });
  const recipeDiscoveryQuery = useQuery({
    queryKey: ['recipe-discovery'],
    queryFn: () => api.getRecipeDiscovery(8),
    enabled: isAuthenticated,
  });
  const recipeStatsQuery = useQuery({
    queryKey: ['recipe-stats'],
    queryFn: () => api.getRecipeStats(undefined, undefined, 10),
    enabled: isAuthenticated,
  });
  const recipeFavoritesQuery = useQuery({
    queryKey: ['recipe-favorites'],
    queryFn: api.getRecipeFavorites,
    enabled: isAuthenticated,
  });
  const foodPlanQuery = useQuery({
    queryKey: ['food-plan', foodPlanWeekRange.start, foodPlanWeekRange.end],
    queryFn: () => api.getFoodPlan(foodPlanWeekRange.start, foodPlanWeekRange.end),
    enabled: isAuthenticated,
    placeholderData: keepPreviousData,
  });
  const foodScenesQuery = useQuery({
    queryKey: ['food-scenes'],
    queryFn: api.getFoodScenes,
    enabled: isAuthenticated,
  });
  const foodsQuery = useQuery({
    queryKey: ['foods'],
    queryFn: api.getFoods,
    enabled: isAuthenticated,
  });
  const foodRecommendationsQuery = useQuery({
    queryKey: ['food-recommendations'],
    queryFn: () => api.getFoodRecommendations({ limit: 12, now: new Date().toISOString() }),
    enabled: isAuthenticated,
  });
  const mealLogsQuery = useQuery({
    queryKey: ['meal-logs'],
    queryFn: api.getMealLogs,
    enabled: isAuthenticated,
  });
  const activityLogsQuery = useQuery({
    queryKey: ['activity-logs'],
    queryFn: api.getActivityLogs,
    enabled: isAuthenticated,
  });
  const aiConversationsQuery = useQuery({
    queryKey: ['ai-conversations'],
    queryFn: api.getAiConversations,
    enabled: isAuthenticated,
  });

  const createMemberMutation = useMutation({
    mutationFn: api.createMember,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['members'] });
      void queryClient.invalidateQueries({ queryKey: ['activity-logs'] });
    },
  });
  const createIngredientMutation = useMutation({
    mutationFn: api.createIngredient,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['ingredients'] });
      void queryClient.invalidateQueries({ queryKey: ['activity-logs'] });
    },
  });
  const updateIngredientMutation = useMutation({
    mutationFn: ({ ingredientId, payload }: { ingredientId: string; payload: Parameters<typeof api.updateIngredient>[1] }) =>
      api.updateIngredient(ingredientId, payload),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['ingredients'] });
      void queryClient.invalidateQueries({ queryKey: ['activity-logs'] });
    },
  });
  const createInventoryMutation = useMutation({
    mutationFn: api.createInventory,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['inventory'] });
      void queryClient.invalidateQueries({ queryKey: ['food-recommendations'] });
      void queryClient.invalidateQueries({ queryKey: ['activity-logs'] });
    },
  });
  const consumeInventoryMutation = useMutation({
    mutationFn: api.consumeInventory,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['inventory'] });
      void queryClient.invalidateQueries({ queryKey: ['food-recommendations'] });
      void queryClient.invalidateQueries({ queryKey: ['activity-logs'] });
    },
  });
  const disposeExpiredInventoryMutation = useMutation({
    mutationFn: api.disposeExpiredInventory,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['inventory'] });
      void queryClient.invalidateQueries({ queryKey: ['food-recommendations'] });
      void queryClient.invalidateQueries({ queryKey: ['activity-logs'] });
    },
  });
  const createShoppingMutation = useMutation({
    mutationFn: api.createShoppingItem,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['shopping-list'] });
      void queryClient.invalidateQueries({ queryKey: ['activity-logs'] });
    },
  });
  const updateShoppingMutation = useMutation({
    mutationFn: ({ itemId, done }: { itemId: string; done: boolean }) => api.updateShoppingItem(itemId, done),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['shopping-list'] });
      void queryClient.invalidateQueries({ queryKey: ['activity-logs'] });
    },
  });
  const createRecipeMutation = useMutation({
    mutationFn: api.createRecipe,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['recipes'] });
      void queryClient.invalidateQueries({ queryKey: ['recipe-discovery'] });
      void queryClient.invalidateQueries({ queryKey: ['recipe-stats'] });
      void queryClient.invalidateQueries({ queryKey: ['foods'] });
      void queryClient.invalidateQueries({ queryKey: ['food-recommendations'] });
      void queryClient.invalidateQueries({ queryKey: ['activity-logs'] });
    },
  });
  const updateRecipeMutation = useMutation({
    mutationFn: ({ recipeId, payload }: { recipeId: string; payload: Parameters<typeof api.updateRecipe>[1] }) =>
      api.updateRecipe(recipeId, payload),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['recipes'] });
      void queryClient.invalidateQueries({ queryKey: ['recipe-discovery'] });
      void queryClient.invalidateQueries({ queryKey: ['recipe-stats'] });
      void queryClient.invalidateQueries({ queryKey: ['foods'] });
      void queryClient.invalidateQueries({ queryKey: ['food-recommendations'] });
      void queryClient.invalidateQueries({ queryKey: ['activity-logs'] });
    },
  });
  const deleteRecipeMutation = useMutation({
    mutationFn: api.deleteRecipe,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['recipes'] });
      void queryClient.invalidateQueries({ queryKey: ['recipe-discovery'] });
      void queryClient.invalidateQueries({ queryKey: ['recipe-stats'] });
      void queryClient.invalidateQueries({ queryKey: ['recipe-favorites'] });
      void queryClient.invalidateQueries({ queryKey: ['food-plan'] });
      void queryClient.invalidateQueries({ queryKey: ['foods'] });
      void queryClient.invalidateQueries({ queryKey: ['food-recommendations'] });
      void queryClient.invalidateQueries({ queryKey: ['activity-logs'] });
    },
  });
  const cookRecipeMutation = useMutation({
    mutationFn: ({ recipeId, payload }: { recipeId: string; payload: Parameters<typeof api.cookRecipe>[1] }) =>
      api.cookRecipe(recipeId, payload),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['inventory'] });
      void queryClient.invalidateQueries({ queryKey: ['recipe-discovery'] });
      void queryClient.invalidateQueries({ queryKey: ['food-recommendations'] });
      void queryClient.invalidateQueries({ queryKey: ['recipe-stats'] });
      void queryClient.invalidateQueries({ queryKey: ['foods'] });
      void queryClient.invalidateQueries({ queryKey: ['meal-logs'] });
      void queryClient.invalidateQueries({ queryKey: ['food-plan'] });
      void queryClient.invalidateQueries({ queryKey: ['activity-logs'] });
    },
  });
  const previewCookRecipeMutation = useMutation({
    mutationFn: ({ recipeId, payload }: { recipeId: string; payload: Parameters<typeof api.previewCookRecipe>[1] }) =>
      api.previewCookRecipe(recipeId, payload),
  });
  const addRecipeFavoriteMutation = useMutation({
    mutationFn: api.addRecipeFavorite,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['recipe-favorites'] });
      void queryClient.invalidateQueries({ queryKey: ['activity-logs'] });
    },
  });
  const removeRecipeFavoriteMutation = useMutation({
    mutationFn: api.removeRecipeFavorite,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['recipe-favorites'] });
      void queryClient.invalidateQueries({ queryKey: ['activity-logs'] });
    },
  });
  const createFoodPlanItemMutation = useMutation({
    mutationFn: api.createFoodPlanItem,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['food-plan'] });
      void queryClient.invalidateQueries({ queryKey: ['activity-logs'] });
    },
  });
  const updateFoodPlanItemMutation = useMutation({
    mutationFn: ({ itemId, payload }: { itemId: string; payload: Parameters<typeof api.updateFoodPlanItem>[1] }) =>
      api.updateFoodPlanItem(itemId, payload),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['food-plan'] });
      void queryClient.invalidateQueries({ queryKey: ['activity-logs'] });
    },
  });
  const deleteFoodPlanItemMutation = useMutation({
    mutationFn: api.deleteFoodPlanItem,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['food-plan'] });
      void queryClient.invalidateQueries({ queryKey: ['activity-logs'] });
    },
  });
  const createFoodSceneMutation = useMutation({
    mutationFn: api.createFoodScene,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['food-scenes'] });
      void queryClient.invalidateQueries({ queryKey: ['activity-logs'] });
    },
  });
  const updateFoodSceneMutation = useMutation({
    mutationFn: ({ sceneId, payload }: { sceneId: string; payload: Parameters<typeof api.updateFoodScene>[1] }) =>
      api.updateFoodScene(sceneId, payload),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['food-scenes'] });
      void queryClient.invalidateQueries({ queryKey: ['activity-logs'] });
    },
  });
  const deleteFoodSceneMutation = useMutation({
    mutationFn: api.deleteFoodScene,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['food-scenes'] });
      void queryClient.invalidateQueries({ queryKey: ['activity-logs'] });
    },
  });
  const createFoodMutation = useMutation({
    mutationFn: api.createFood,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['foods'] });
      void queryClient.invalidateQueries({ queryKey: ['food-recommendations'] });
      void queryClient.invalidateQueries({ queryKey: ['activity-logs'] });
    },
  });
  const updateFoodMutation = useMutation({
    mutationFn: ({ foodId, payload }: { foodId: string; payload: Parameters<typeof api.updateFood>[1] }) =>
      api.updateFood(foodId, payload),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['foods'] });
      void queryClient.invalidateQueries({ queryKey: ['food-recommendations'] });
      void queryClient.invalidateQueries({ queryKey: ['activity-logs'] });
    },
  });
  const toggleFavoriteMutation = useMutation({
    mutationFn: ({ foodId, favorite }: { foodId: string; favorite: boolean }) =>
      api.updateFoodFavorite(foodId, favorite),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['foods'] });
      void queryClient.invalidateQueries({ queryKey: ['food-recommendations'] });
      void queryClient.invalidateQueries({ queryKey: ['activity-logs'] });
    },
  });
  const createMealMutation = useMutation({
    mutationFn: api.createMealLog,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['meal-logs'] });
      void queryClient.invalidateQueries({ queryKey: ['food-recommendations'] });
      void queryClient.invalidateQueries({ queryKey: ['activity-logs'] });
    },
  });
  const quickAddMealMutation = useMutation({
    mutationFn: api.quickAddMealLog,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['meal-logs'] });
      void queryClient.invalidateQueries({ queryKey: ['food-plan'] });
      void queryClient.invalidateQueries({ queryKey: ['food-recommendations'] });
      void queryClient.invalidateQueries({ queryKey: ['activity-logs'] });
    },
  });
  const aiMutation = useMutation({
    mutationFn: api.queryAi,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['ai-conversations'] });
      void queryClient.invalidateQueries({ queryKey: ['family'] });
      void queryClient.invalidateQueries({ queryKey: ['activity-logs'] });
    },
  });

  const members = membersQuery.data ?? [];
  const ingredients = ingredientsQuery.data ?? [];
  const inventoryItems = inventoryQuery.data ?? [];
  const shoppingItems = shoppingQuery.data ?? [];
  const recipes = recipesQuery.data ?? [];
  const recipeDiscovery: RecipeDiscovery | null = recipeDiscoveryQuery.data ?? null;
  const recipeStats: RecipeStats | null = recipeStatsQuery.data ?? null;
  const recipeFavorites = recipeFavoritesQuery.data ?? [];
  const foodPlanItems = foodPlanQuery.data ?? [];
  const foodScenes: FoodScene[] = foodScenesQuery.data ?? [];
  const foods = foodsQuery.data ?? [];
  const foodRecommendations: FoodRecommendations | null = foodRecommendationsQuery.data ?? null;
  const mealLogs = mealLogsQuery.data ?? [];
  const activityLogs = activityLogsQuery.data ?? [];
  const aiConversations = aiConversationsQuery.data ?? [];
  const family = familyQuery.data;
  const homePlanDetailItem = homePlanDetailItemId
    ? foodPlanItems.find((item) => item.id === homePlanDetailItemId) ?? null
    : null;
  const homePlanDetailFood = homePlanDetailItem
    ? foods.find((food) => food.id === homePlanDetailItem.food_id) ?? null
    : null;
  const homePlanAddFood = homePlanAddFoodId
    ? foods.find((food) => food.id === homePlanAddFoodId) ?? null
    : null;
  const homePlanAddFoodOptions = foods
    .filter((food) => {
      const query = homePlanAddFoodSearch.trim().toLowerCase();
      if (!query) return true;
      return [food.name, food.category, food.source_name, food.purchase_source, food.scene, food.notes, food.routine_note]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()
        .includes(query);
    })
    .slice(0, 8);

  useEffect(() => {
    setVisibleExpiryCount(10);
  }, [inventoryItems.length]);

  useEffect(() => {
    if (!homePlanDetailItem) {
      return;
    }
    setHomePlanDetailForm({
      planDate: homePlanDetailItem.plan_date < todayKey() ? todayKey() : homePlanDetailItem.plan_date,
      mealType: homePlanDetailItem.meal_type,
      note: homePlanDetailItem.note ?? '',
    });
  }, [homePlanDetailItem?.id, homePlanDetailItem?.meal_type, homePlanDetailItem?.note, homePlanDetailItem?.plan_date]);

  useEffect(() => {
    const defaultDate = todayKey();
    if (defaultDate >= foodPlanWeekRange.start && defaultDate <= foodPlanWeekRange.end) {
      setSelectedDashboardPlanDate(defaultDate);
      return;
    }
    setSelectedDashboardPlanDate(foodPlanWeekRange.start);
  }, [foodPlanWeekRange.end, foodPlanWeekRange.start]);

  if (!isAuthenticated) {
    return <LoginScreen />;
  }

  const isBootLoading =
    authLoading ||
    familyQuery.isLoading ||
    membersQuery.isLoading ||
    ingredientsQuery.isLoading ||
    inventoryQuery.isLoading ||
    shoppingQuery.isLoading ||
    recipesQuery.isLoading ||
    recipeFavoritesQuery.isLoading ||
    (foodPlanQuery.isLoading && !foodPlanQuery.data) ||
    foodScenesQuery.isLoading ||
    foodsQuery.isLoading ||
    mealLogsQuery.isLoading ||
    activityLogsQuery.isLoading ||
    aiConversationsQuery.isLoading;

  if (isBootLoading) {
    return (
      <main className="login-shell">
        <section className="login-card">
          <h1>正在连接家庭厨房...</h1>
          <p className="subtle">真实后端、MySQL 和家庭数据正在加载。</p>
        </section>
      </main>
    );
  }

  const currentUser = user;
  const inventoryAlerts = buildInventoryAlerts(inventoryItems, ingredients);
  const familyStats = {
    foods: foods.length,
    recipes: recipes.length,
    ingredients: ingredients.length,
    mealsToday: mealLogs.filter((item) => item.date === todayKey()).length,
  };
  const pendingShoppingCount = shoppingItems.filter((item) => !item.done).length;
  const aiRecommendationCount = (family?.ai_recommendations ?? []).length;
  const todaysMeals = mealLogs.filter((item) => item.date === todayKey());
  const recentMeals = [...mealLogs].slice(0, 6);
  const filteredFoods = foods.filter((food) => {
    const searchMatch =
      food.name.includes(foodSearch) ||
      food.category.includes(foodSearch) ||
      (food.scene_tags ?? []).some((tag) => tag.includes(foodSearch));
    const typeMatch = foodTypeFilter === 'all' || food.type === foodTypeFilter;
    return searchMatch && typeMatch;
  });
  const foodImagePayload = buildFoodImagePayload(foodForm, recipes);
  const mealImagePayload = buildMealImagePayload(mealForm, mealFoodEntries, foods);
  const foodSubmitDisabled = createFoodMutation.isPending || foodImageState.isGenerating;
  const mealSubmitDisabled = createMealMutation.isPending || mealImageState.isGenerating;
  const isOwner = membership?.role === 'Owner';
  const foodValidIngredientBinding = foodForm.type !== 'selfMade' || Boolean(foodForm.recipeId);
  const foodSummaryItems = [
    { label: '名称', value: foodForm.name.trim() || '未填写食物名称' },
    { label: '类型', value: FOOD_TYPE_LABELS[foodForm.type] },
    { label: '分类', value: foodForm.category.trim() || '未设置分类' },
    {
      label: '图片',
      value: foodForm.images.generatedAsset
        ? 'AI 主图已生成'
        : foodForm.images.referenceAsset
          ? '参考图已上传'
          : '暂未配图',
    },
  ];
  function countRecentMealUsage(foodId: string) {
    return mealLogs.filter((log) => log.food_entries.some((entry) => entry.food_id === foodId)).length;
  }

  async function handleImageUpload(
    files: FileList | null,
    payload: AiRenderPayload,
    onChange: (next: ImageInputValue) => void,
    setImageState: (next: ImageGenerationUiState) => void
  ) {
    if (!files || files.length === 0) {
      return;
    }
    const [file] = Array.from(files);
    if (!file) {
      return;
    }
    setImageState({ isGenerating: true, errorMessage: null });
    try {
      const nextImages = await uploadReferenceAndGenerateImage(file, payload);
      onChange(nextImages);
      setImageState(IDLE_IMAGE_GENERATION_STATE);
    } catch (reason) {
      const message = resolveImageGenerationErrorMessage(reason, '参考图上传或 AI 主图生成失败');
      const referenceAsset = extractReferenceAsset(reason);
      onChange(referenceAsset ? { referenceAsset } : emptyImages());
      setImageState({
        isGenerating: false,
        errorMessage: referenceAsset ? `${message}，参考图已保留，可重试生成主图。` : message,
      });
    }
  }

  async function handleGenerateImage(
    mode: 'reference' | 'text',
    currentValue: ImageInputValue,
    payload: AiRenderPayload,
    onChange: (next: ImageInputValue) => void,
    setImageState: (next: ImageGenerationUiState) => void
  ) {
    setImageState({ isGenerating: true, errorMessage: null });
    try {
      const nextImages =
        mode === 'reference' && currentValue.referenceAsset
          ? await regenerateImageFromReference(currentValue.referenceAsset.id, payload)
          : await generateImageFromText(payload);
      onChange({
        referenceAsset: nextImages.referenceAsset ?? currentValue.referenceAsset,
        generatedAsset: nextImages.generatedAsset,
      });
      setImageState(IDLE_IMAGE_GENERATION_STATE);
    } catch (reason) {
      setImageState({
        isGenerating: false,
        errorMessage: resolveImageGenerationErrorMessage(reason, 'AI 主图生成失败'),
      });
    }
  }

  function resetImageInput(
    onChange: (value: ImageInputValue) => void,
    setImageState: (next: ImageGenerationUiState) => void
  ) {
    onChange(emptyImages());
    setImageState(IDLE_IMAGE_GENERATION_STATE);
  }

  async function submitFood(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const name =
      foodForm.type === 'selfMade' && !foodForm.name.trim()
        ? recipes.find((recipe) => recipe.id === foodForm.recipeId)?.title ?? ''
        : foodForm.name.trim();
    if (!name) {
      window.alert('请填写食物名称。');
      return;
    }
    if (foodForm.type === 'selfMade' && !foodForm.recipeId) {
      window.alert('自做菜需要先关联一个菜谱。');
      return;
    }
    try {
      await createFoodMutation.mutateAsync({
        name,
        type: foodForm.type,
        category: foodForm.category || '未分类',
        flavor_tags: [],
        scene_tags: splitTags(foodForm.flavorTags),
        suitable_meal_types: ['lunch', 'dinner'],
        source_name: foodForm.sourceName || (foodForm.type === 'selfMade' ? '家庭厨房' : ''),
        purchase_source: foodForm.sourceName || (foodForm.type === 'selfMade' ? '家庭厨房' : ''),
        scene: foodForm.scene,
        notes: foodForm.notes,
        routine_note: '',
        price: null,
        rating: null,
        repurchase: null,
        expiry_date: null,
        stock_quantity: null,
        stock_unit: '',
        favorite: foodForm.favorite,
        recipe_id: foodForm.recipeId || null,
        media_ids: getMediaIds(foodForm.images),
      });
      setFoodImageState(IDLE_IMAGE_GENERATION_STATE);
      setFoodForm({
        name: '',
        type: 'takeout',
        category: '',
        flavorTags: '',
        sourceName: '',
        scene: '',
        notes: '',
        favorite: false,
        recipeId: '',
        images: emptyImages(),
      });
      setFoodWorkspaceView('list');
    } catch (reason) {
      window.alert(reason instanceof Error ? reason.message : '保存食物失败');
    }
  }

  async function submitMeal(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (mealFoodEntries.length === 0) {
      window.alert('至少选择一个食物来记录这一餐。');
      return;
    }
    try {
      await createMealMutation.mutateAsync({
        date: mealForm.date,
        meal_type: mealForm.mealType,
        food_entries: mealFoodEntries,
        participant_user_ids: selectedParticipants,
        notes: mealForm.notes,
        mood: mealForm.mood,
        media_ids: getMediaIds(mealForm.photos),
      });
      setMealImageState(IDLE_IMAGE_GENERATION_STATE);
      setMealForm({
        date: todayKey(),
        mealType: 'dinner',
        notes: '',
        mood: '满足',
        photos: emptyImages(),
      });
      setMealFoodEntries([]);
      setSelectedParticipants(currentUser ? [currentUser.id] : []);
    } catch (reason) {
      window.alert(reason instanceof Error ? reason.message : '保存餐食记录失败');
    }
  }

  async function submitAi(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    try {
      await aiMutation.mutateAsync({
        mode: aiMode,
        prompt: aiPrompt.trim(),
        food_id: aiFoodId || undefined,
        ingredient_ids: selectedAiIngredientIds,
      });
      setAiPrompt('');
    } catch (reason) {
      window.alert(reason instanceof Error ? reason.message : 'AI 请求失败');
    }
  }

  async function submitInvite(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!inviteForm.username.trim() || !inviteForm.displayName.trim() || !inviteForm.password.trim()) return;
    try {
      await createMemberMutation.mutateAsync({
        username: inviteForm.username.trim(),
        display_name: inviteForm.displayName.trim(),
        password: inviteForm.password,
        role: inviteForm.role,
        email: inviteForm.email.trim() || undefined,
      });
      setInviteForm({
        username: '',
        displayName: '',
        password: 'Culina123!',
        role: 'Member',
        email: '',
      });
      setFamilyOverlayMode(null);
    } catch (reason) {
      window.alert(reason instanceof Error ? reason.message : '创建成员账号失败');
    }
  }

  function handleMealFoodToggle(foodId: string, checked: boolean) {
    setMealFoodEntries((current) => {
      if (checked) {
        return [...current, { food_id: foodId, servings: 1, note: '' }];
      }
      return current.filter((item) => item.food_id !== foodId);
    });
  }

  function updateMealFood(foodId: string, key: 'servings' | 'note', value: string) {
    setMealFoodEntries((current) =>
      current.map((item) =>
        item.food_id === foodId
          ? { ...item, [key]: key === 'servings' ? Number(value) : value }
          : item
      )
    );
  }

  function updateParticipant(userId: string, checked: boolean) {
    setSelectedParticipants((current) =>
      checked ? [...current, userId] : current.filter((item) => item !== userId)
    );
  }

  function updateAiIngredients(ingredientId: string, checked: boolean) {
    setSelectedAiIngredientIds((current) =>
      checked ? [...current, ingredientId] : current.filter((item) => item !== ingredientId)
    );
  }

  const headerName = currentUser?.display_name ?? '家庭成员';
  const today = todayKey();
  const ingredientById = new Map(ingredients.map((ingredient) => [ingredient.id, ingredient]));
  const availableInventoryCount = inventoryItems.filter((item) => (item.remaining_quantity ?? item.quantity) > 0).length;
  const expiringInventoryItems = inventoryItems
    .filter((item) => (item.remaining_quantity ?? item.quantity) > 0 && item.expiry_date)
    .map((item) => ({
      ...item,
      daysLeft: item.expiry_date ? getExpiryDaysLeft(item.expiry_date, today) : 99,
    }))
    .filter((item) => item.daysLeft <= 7)
    .sort((left, right) => left.daysLeft - right.daysLeft);
  const visibleExpiringInventoryItems = expiringInventoryItems.slice(0, visibleExpiryCount);
  const activeFoodPlanItems = foodPlanItems.filter((item) => item.status !== 'skipped');
  const dashboardStats = [
    {
      label: '在库食材',
      value: `${availableInventoryCount}`,
      unit: '种',
      detail: '库存充足',
      icon: 'leaf' as const,
      tone: 'green',
    },
    {
      label: '临期提醒',
      value: `${inventoryAlerts.length}`,
      unit: '项',
      detail: '已过期/7 天内到期',
      icon: 'bell' as const,
      tone: 'coral',
    },
    {
      label: '待采购',
      value: `${pendingShoppingCount}`,
      unit: '项',
      detail: pendingShoppingCount > 0 ? '建议尽快补齐' : '清单已完成',
      icon: 'cart' as const,
      tone: 'yellow',
    },
    {
      label: '本周做菜',
      value: `${activeFoodPlanItems.length}`,
      unit: '餐',
      detail: '计划进行中',
      icon: 'pot' as const,
      tone: 'violet',
    },
  ];
  const dashboardRecommendationItems = (foodRecommendations?.items ?? [])
    .map((item) => ({
      recommendation: item,
      coverUrl: getFoodCover(item.food, recipes),
    }));
  const dashboardRecommendationPageCount = Math.max(1, Math.ceil(dashboardRecommendationItems.length / 3));
  const dashboardRecommendations = dashboardRecommendationItems.slice(
    (dashboardRecommendationPage % dashboardRecommendationPageCount) * 3,
    (dashboardRecommendationPage % dashboardRecommendationPageCount) * 3 + 3
  );
  const dashboardTodoItems: DashboardTodoItem[] = [
    ...expiringInventoryItems.map((item) => ({
      type: 'expiry' as const,
      id: `expiry-${item.id}`,
      title: `处理临期${item.ingredient_name}`,
      status: item.daysLeft <= 1 ? '紧急' : '待办',
      done: false as const,
      dateLabel: item.daysLeft <= 0 ? '今天' : formatRelativeDays(item.expiry_date ?? today),
      description: `${item.storage_location || INVENTORY_STATUS_LABELS[item.status]} · ${
        item.expiry_date ? formatDate(item.expiry_date) : '未记录到期日'
      }到期`,
      icon: 'bell' as const,
      item,
    })),
    ...shoppingItems
      .filter((item) => !item.done)
      .map((item) => ({
        type: 'shopping' as const,
        id: `shopping-${item.id}`,
        title: `补齐${item.title}`,
        status: '待办',
        done: false as const,
        dateLabel: '今天',
        description: `${item.quantity}${item.unit || ''}${item.reason ? ` · ${item.reason}` : ' · 采购后可快速入库'}`,
        icon: 'cart' as const,
        item,
      })),
    ...todaysMeals.map((meal) => ({
      type: 'meal' as const,
      id: `meal-${meal.id}`,
      title: `记录${MEAL_TYPE_LABELS[meal.meal_type]}`,
      status: '已完成',
      done: true as const,
      dateLabel: '今天',
      description:
        meal.food_entries.length > 0
          ? meal.food_entries.map((entry) => entry.food_name).join('、')
          : meal.notes || '查看这餐的记录详情',
      icon: 'check' as const,
      item: meal,
    })),
  ];
  const visibleDashboardTodoItems = dashboardTodoItems.slice(0, visibleDashboardTodoCount);
  const hasMoreDashboardTodoItems = visibleDashboardTodoItems.length < dashboardTodoItems.length;
  const dashboardCompletedCount = dashboardTodoItems.filter((item) => item.done).length;
  const dashboardWeekMealCapacity = 7 * DASHBOARD_PLAN_MEAL_TYPES.length;
  const completedFoodPlanCount = activeFoodPlanItems.filter((item) => item.status === 'cooked').length;
  const pendingFoodPlanSlots = Math.max(0, dashboardWeekMealCapacity - activeFoodPlanItems.length);
  const dashboardPlanSummary = [
    { label: '已安排', value: activeFoodPlanItems.length, icon: 'receipt' as const, tone: 'orange' },
    { label: '待补充', value: pendingFoodPlanSlots, icon: 'flame' as const, tone: 'amber' },
    { label: '已完成', value: completedFoodPlanCount, icon: 'check' as const, tone: 'green' },
  ];
  const dashboardPlanDays = Array.from({ length: 7 }, (_, index) => {
    const date = addDateKeyDays(foodPlanWeekRange.start, index);
    const dayItems = activeFoodPlanItems.filter((entry) => entry.plan_date === date);
    const mealItems = DASHBOARD_PLAN_MEAL_TYPES.map((mealType) => {
      const items = dayItems.filter((item) => item.meal_type === mealType);
      return {
        mealType,
        items,
      };
    });
    const plannedMealCount = mealItems.filter((entry) => entry.items.length > 0).length;
    return {
      date,
      weekday: ['一', '二', '三', '四', '五', '六', '日'][index],
      dayLabel: formatDate(date).replace('周', ''),
      mealItems,
      plannedMealCount,
      totalCount: dayItems.length,
      isToday: date === today,
      isSelected: date === selectedDashboardPlanDate,
    };
  });
  const selectedDashboardPlanDay =
    dashboardPlanDays.find((day) => day.date === selectedDashboardPlanDate) ?? dashboardPlanDays[0];
  const selectedDashboardPlanDateLabel = selectedDashboardPlanDay
    ? `${selectedDashboardPlanDay.isToday ? '今天' : `周${selectedDashboardPlanDay.weekday}`} · ${selectedDashboardPlanDay.dayLabel}`
    : '';
  const pendingShoppingPreview = shoppingItems.filter((item) => !item.done);
  const homeRestockShoppingItem = homeRestockShoppingItemId
    ? shoppingItems.find((item) => item.id === homeRestockShoppingItemId) ?? null
    : null;
  const homeExpiryReviewItem = homeExpiryReviewItemId
    ? expiringInventoryItems.find((item) => item.id === homeExpiryReviewItemId) ?? null
    : null;
  const homeExpiryReviewIngredient = homeExpiryReviewItem
    ? ingredientById.get(homeExpiryReviewItem.ingredient_id) ?? null
    : null;
  const homeMealDetail = homeMealDetailId
    ? mealLogs.find((item) => item.id === homeMealDetailId) ?? null
    : null;
  const homeMealDetailParticipants = homeMealDetail
    ? members.filter((member) => homeMealDetail.participant_user_ids.includes(member.id))
    : [];
  const homeRestockIngredient =
    homeRestockForm?.ingredientId ? ingredients.find((item) => item.id === homeRestockForm.ingredientId) ?? null : null;
  const homeRestockIngredientImageUrl =
    homeRestockIngredient?.image?.url ? resolveDashboardAssetUrl(homeRestockIngredient.image.url) : undefined;

  function resolveDashboardAssetUrl(url?: string) {
    if (!url) return undefined;
    if (url.startsWith('http://') || url.startsWith('https://') || url.startsWith('data:')) return url;
    return `${API_BASE_URL}${url}`;
  }

  function openIngredientsCatalog() {
    ingredientNavigationRequestIdRef.current += 1;
    setIngredientNavigationRequest({ view: 'catalog', requestId: ingredientNavigationRequestIdRef.current });
    setActiveTab('ingredients');
  }

  function openIngredientDetail(ingredientId: string) {
    ingredientNavigationRequestIdRef.current += 1;
    setIngredientNavigationRequest({ view: 'detail', ingredientId, requestId: ingredientNavigationRequestIdRef.current });
    setActiveTab('ingredients');
  }

  function openIngredientExpiredDisposal(ingredientId: string) {
    setHomeExpiredDisposalIngredientId(ingredientId);
  }

  function openHomeExpiryReview(item: DashboardExpiryTodoInventoryItem) {
    setHomeExpiryReviewItemId(item.id);
  }

  function closeHomeExpiryReview() {
    setHomeExpiryReviewItemId(null);
  }

  function openHomeRestock(item: ShoppingListItem) {
    setHomeRestockShoppingItemId(item.id);
    setHomeRestockForm(buildHomeRestockForm(item, ingredients));
  }

  function closeHomeRestock() {
    setHomeRestockShoppingItemId(null);
    setHomeRestockForm(null);
  }

  function closeHomeMealDetail() {
    setHomeMealDetailId(null);
  }

  function handleDashboardTodoClick(item: DashboardTodoItem) {
    if (item.type === 'expiry') {
      if (item.item.daysLeft < 0) {
        openIngredientExpiredDisposal(item.item.ingredient_id);
        return;
      }
      openHomeExpiryReview(item.item);
      return;
    }
    if (item.type === 'shopping') {
      openHomeRestock(item.item);
      return;
    }
    setHomeMealDetailId(item.item.id);
  }

  function updateHomeRestockForm(next: HomeRestockFormState) {
    setHomeRestockForm(next);
  }

  function openHomePlanDetail(item: FoodPlanItem) {
    setHomePlanDetailItemId(item.id);
    setHomePlanDetailForm({
      planDate: item.plan_date < todayKey() ? todayKey() : item.plan_date,
      mealType: item.meal_type,
      note: item.note ?? '',
    });
    setIsHomePlanDetailEditing(false);
  }

  function closeHomePlanDetail() {
    setHomePlanDetailItemId(null);
    setIsHomePlanDetailEditing(false);
  }

  function resetHomePlanDetailForm() {
    if (!homePlanDetailItem) return;
    setHomePlanDetailForm({
      planDate: homePlanDetailItem.plan_date < todayKey() ? todayKey() : homePlanDetailItem.plan_date,
      mealType: homePlanDetailItem.meal_type,
      note: homePlanDetailItem.note ?? '',
    });
    setIsHomePlanDetailEditing(false);
  }

  function getDefaultHomePlanMealType(food: Food, fallback: MealType = 'dinner') {
    return food.suitable_meal_types[0] ?? fallback;
  }

  function openHomePlanAddDialog(food: Food, fallbackMealType: MealType = 'dinner') {
    setIsHomePlanAddDialogOpen(true);
    setHomePlanAddFoodId(food.id);
    setHomePlanAddFoodSearch(food.name);
    setHomePlanAddForm({
      planDate: selectedDashboardPlanDate,
      mealType: getDefaultHomePlanMealType(food, fallbackMealType),
      note: '',
    });
  }

  function openHomePlanAddEmptyDialog(planDate: string, mealType: MealType) {
    setIsHomePlanAddDialogOpen(true);
    setHomePlanAddFoodId(null);
    setHomePlanAddFoodSearch('');
    setHomePlanAddForm({
      planDate,
      mealType,
      note: '',
    });
  }

  function selectHomePlanAddFood(food: Food) {
    setHomePlanAddFoodId(food.id);
    setHomePlanAddFoodSearch(food.name);
    setHomePlanAddForm((current) => ({
      ...current,
      mealType: getDefaultHomePlanMealType(food, current.mealType),
    }));
  }

  function closeHomePlanAddDialog() {
    setIsHomePlanAddDialogOpen(false);
    setHomePlanAddFoodId(null);
    setHomePlanAddFoodSearch('');
    setHomePlanAddForm({
      planDate: todayKey(),
      mealType: 'dinner',
      note: '',
    });
  }

  async function startHomePlanDetailCook(item: FoodPlanItem) {
    closeHomePlanDetail();
    if (item.recipe_id) {
      setPendingRecipeCookId(item.recipe_id);
      setPendingFoodPlanCookItemId(item.id);
      setActiveTab('recipes');
      return;
    }
    try {
      await quickAddMealMutation.mutateAsync({
        food_id: item.food_id,
        date: item.plan_date,
        meal_type: item.meal_type,
        servings: 1,
        note: item.note || '来自菜单计划',
        food_plan_item_id: item.id,
      });
    } catch (reason) {
      window.alert(reason instanceof Error ? reason.message : '完成菜单计划失败');
    }
  }

  function handleExpiryListScroll(event: UIEvent<HTMLDivElement>) {
    const target = event.currentTarget;
    if (target.scrollTop + target.clientHeight < target.scrollHeight - 24) {
      return;
    }
    setVisibleExpiryCount((current) => Math.min(current + 10, expiringInventoryItems.length));
  }

  function handleDashboardTodoListScroll(event: UIEvent<HTMLDivElement>) {
    const target = event.currentTarget;
    if (target.scrollTop + target.clientHeight < target.scrollHeight - 18) {
      return;
    }
    setVisibleDashboardTodoCount((current) => Math.min(current + DASHBOARD_TODO_PAGE_SIZE, dashboardTodoItems.length));
  }

  const ingredientSummaries = buildIngredientSummaries({
    ingredients,
    inventoryItems,
    recipes,
  });
  const homeExpiredDisposalSummary =
    ingredientSummaries.find((item) => item.ingredient.id === homeExpiredDisposalIngredientId) ?? null;
  const homeExpiredDisposalItems = homeExpiredDisposalSummary
    ? buildDisposableExpiredInventoryItems(homeExpiredDisposalSummary)
    : [];

  async function submitHomeExpiredDisposal(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!homeExpiredDisposalSummary) {
      window.alert('这份食材暂时不可用，请稍后再试。');
      return;
    }
    if (homeExpiredDisposalItems.length === 0) {
      window.alert('当前没有可销毁的过期批次。');
      return;
    }

    try {
      await disposeExpiredInventoryMutation.mutateAsync({
        ingredient_id: homeExpiredDisposalSummary.ingredient.id,
        inventory_item_ids: homeExpiredDisposalItems.map((item) => item.id),
      });
      setHomeExpiredDisposalIngredientId(null);
    } catch (reason) {
      window.alert(reason instanceof Error ? reason.message : '销毁过期批次失败');
    }
  }

  async function submitHomeRestock(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!homeRestockShoppingItem || !homeRestockForm) {
      window.alert('先选择要登记的采购项。');
      return;
    }
    if (!homeRestockForm.ingredientId) {
      window.alert('请先匹配一份食材档案，再登记库存。');
      return;
    }
    const quantity = parsePositiveNumber(homeRestockForm.quantity);
    if (quantity === null) {
      window.alert('数量要大于 0，才能把这批库存记进系统。');
      return;
    }
    if (!homeRestockForm.purchaseDate) {
      window.alert('请确认这批食材的购买日期。');
      return;
    }
    if (!homeRestockForm.storageLocation.trim()) {
      window.alert('请确认这批食材放在哪里。');
      return;
    }
    if (homeRestockForm.expiryInputMode === 'days' && parsePositiveNumber(homeRestockForm.expiryDays) === null) {
      window.alert('请填写这批食材大概几天后到期。');
      return;
    }
    if (homeRestockForm.expiryInputMode === 'manual_date' && !homeRestockForm.expiryDate) {
      window.alert('请填写包装上的到期日期。');
      return;
    }

    try {
      await createInventoryMutation.mutateAsync({
        ingredient_id: homeRestockForm.ingredientId,
        quantity,
        unit: homeRestockForm.unit.trim() || homeRestockIngredient?.default_unit || '个',
        status: homeRestockForm.status,
        purchase_date: homeRestockForm.purchaseDate,
        expiry_date: homeRestockForm.expiryDate || undefined,
        storage_location: homeRestockForm.storageLocation.trim(),
        notes: homeRestockForm.notes.trim(),
      });
      try {
        await updateShoppingMutation.mutateAsync({ itemId: homeRestockShoppingItem.id, done: true });
      } catch (reason) {
        window.alert(
          reason instanceof Error
            ? `库存已登记，但待买项仍未标记完成：${reason.message}`
            : '库存已登记，但待买项仍未标记为已买，请稍后再试。'
        );
      }
      closeHomeRestock();
    } catch (reason) {
      window.alert(reason instanceof Error ? reason.message : '录入库存失败');
    }
  }

  async function submitHomePlanDetail(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!homePlanDetailItem) {
      return;
    }
    try {
      await updateFoodPlanItemMutation.mutateAsync({
        itemId: homePlanDetailItem.id,
        payload: {
          plan_date: homePlanDetailForm.planDate,
          meal_type: homePlanDetailForm.mealType,
          note: homePlanDetailForm.note.trim(),
        },
      });
      setIsHomePlanDetailEditing(false);
    } catch (reason) {
      window.alert(reason instanceof Error ? reason.message : '更新菜单计划失败');
    }
  }

  async function deleteHomePlanDetail(item: FoodPlanItem) {
    try {
      await deleteFoodPlanItemMutation.mutateAsync(item.id);
      closeHomePlanDetail();
    } catch (reason) {
      window.alert(reason instanceof Error ? reason.message : '删除菜单计划失败');
    }
  }

  async function submitHomePlanAdd(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!homePlanAddFood) {
      window.alert('请选择要加入菜单的食物。');
      return;
    }
    try {
      await createFoodPlanItemMutation.mutateAsync({
        food_id: homePlanAddFood.id,
        plan_date: homePlanAddForm.planDate,
        meal_type: homePlanAddForm.mealType,
        note: homePlanAddForm.note.trim(),
      });
      closeHomePlanAddDialog();
    } catch (reason) {
      window.alert(reason instanceof Error ? reason.message : '加入菜单失败');
    }
  }

  return (
    <div className="app-shell">
      <div className="page-glow page-glow-left" />
      <div className="page-glow page-glow-right" />
      <div className={sidebarCollapsed ? 'app-frame sidebar-collapsed' : 'app-frame sidebar-expanded'}>
        <aside className="sidebar-shell card">
          <div className="sidebar-top">
            <div className="sidebar-brand">
              <div className="sidebar-brand-row">
                <div className="sidebar-mark">
                  <ShellIcon name="logo" />
                </div>
                <div className="sidebar-brand-copy">
                  <strong>Culina</strong>
                  <span>家庭厨房工作台</span>
                </div>
                <button
                  className="sidebar-toggle"
                  type="button"
                  onClick={() => setSidebarCollapsed((current) => !current)}
                  aria-label={sidebarCollapsed ? '展开侧边栏' : '收起侧边栏'}
                  title={sidebarCollapsed ? '展开侧边栏' : '收起侧边栏'}
                >
                  <ShellIcon name={sidebarCollapsed ? 'panel-open' : 'panel-close'} />
                </button>
              </div>
              <div className="sidebar-family">
                <p className="eyebrow">家庭工作台</p>
                <h2>{family?.name ?? 'Culina 家庭厨房'}</h2>
                <p className="subtle">把食物、食材、记录和协作放在一个安静的大屏工作区里。</p>
              </div>
            </div>

            <nav className="sidebar-nav" aria-label="大屏主导航">
              {NAV_ITEMS.map((item) => (
                <button
                  key={item.key}
                  className={activeTab === item.key ? 'sidebar-nav-item active' : 'sidebar-nav-item'}
                  type="button"
                  onClick={() => setActiveTab(item.key)}
                  aria-label={item.label}
                  title={item.label}
                >
                  <span className="sidebar-icon">
                    <ShellIcon name={item.icon} />
                  </span>
                  <span className="sidebar-label">{item.label}</span>
                </button>
              ))}
            </nav>
          </div>

          <div className="sidebar-footer">
            <div className="current-user-card sidebar-user-card">
              <Avatar label={headerName} seed={currentUser?.avatar_seed ?? headerName} large={!sidebarCollapsed} />
              <div className="sidebar-user-copy">
                <strong>{headerName}</strong>
                <p className="subtle">{membership?.role ?? 'Member'} · {currentUser?.username}</p>
              </div>
            </div>
            <button
              className="ghost-button sidebar-logout"
              type="button"
              onClick={() => void logout()}
              title="退出登录"
            >
              <span className="sidebar-logout-icon">
                <ShellIcon name="logout" />
              </span>
              <span className="sidebar-logout-label">退出登录</span>
            </button>
          </div>
        </aside>

        <div className="app-content">
          <nav className="tabbar">
            <div className="tabbar-scroll">
              {NAV_ITEMS.map((item) => (
                <button
                  key={item.key}
                  className={activeTab === item.key ? 'tab-button active' : 'tab-button'}
                  type="button"
                  onClick={() => setActiveTab(item.key)}
                >
                  {item.label}
                </button>
              ))}
            </div>
          </nav>

          {activeTab === 'home' && (
          <main className="dashboard-page">
            <section className="card dashboard-hero">
              <div className="dashboard-hero-head">
                <div>
                  <h1>首页</h1>
                  <p>把今天要做、要买、要处理的事放在一个清晰工作台里。</p>
                </div>
                <div className="dashboard-hero-actions">
                  <button className="solid-button dashboard-action-primary" type="button" onClick={() => setActiveTab('ingredients')}>
                    <DashboardIcon name="plus" />
                    新增食材
                  </button>
                  <button className="ghost-button dashboard-action-secondary" type="button" onClick={() => setActiveTab('logs')}>
                    <DashboardIcon name="receipt" />
                    记录一餐
                  </button>
                </div>
              </div>

              <div className="dashboard-stat-grid">
                {dashboardStats.map((item) => (
                  <article key={item.label} className="dashboard-stat-card">
                    <span className={`dashboard-stat-icon tone-${item.tone}`}>
                      <DashboardIcon name={item.icon} />
                    </span>
                    <div>
                      <span>{item.label}</span>
                      <strong>
                        {item.value}
                        <small>{item.unit}</small>
                      </strong>
                      <p>{item.detail}</p>
                    </div>
                  </article>
                ))}
              </div>
            </section>

            <div className="dashboard-layout">
              <div className="dashboard-left">
                <section className="card dashboard-panel dashboard-recommend-panel">
                  <div className="dashboard-panel-head">
                    <h2>今天吃什么 <span>✦</span></h2>
                    <button
                      className="ghost-button button-compact"
                      type="button"
                      onClick={() => setDashboardRecommendationPage((current) => (current + 1) % dashboardRecommendationPageCount)}
                      disabled={dashboardRecommendationItems.length <= 3}
                    >
                      换一批
                    </button>
                  </div>
                  {dashboardRecommendations.length > 0 ? (
                    <div className="dashboard-food-row">
                      {dashboardRecommendations.map(({ recommendation, coverUrl }) => {
                        const food = recommendation.food;
                        return (
                          <article key={food.id} className="dashboard-food-card">
                            <div
                              className="dashboard-food-cover"
                              style={
                                resolveDashboardAssetUrl(coverUrl)
                                  ? { backgroundImage: `url("${resolveDashboardAssetUrl(coverUrl)}")` }
                                  : undefined
                              }
                            />
                            <div className="dashboard-food-body">
                              <h3>{food.name}</h3>
                              <div className="dashboard-chip-row">
                                <Badge>{FOOD_TYPE_LABELS[food.type]}</Badge>
                                <Badge>{food.routine_note || `${food.suitable_meal_types.length || 1} 餐适合`}</Badge>
                              </div>
                              <p>{recommendation.reasons[0] ?? food.notes ?? '适合今天安排'}</p>
                              <div className="dashboard-food-actions">
                                <button
                                  className="solid-button button-compact"
                                  type="button"
                                  onClick={() => {
                                    if (food.recipe_id) {
                                      setPendingRecipeCookId(food.recipe_id);
                                      setActiveTab('recipes');
                                      return;
                                    }
                                    void quickAddMealMutation.mutateAsync({
                                      food_id: food.id,
                                      date: today,
                                      meal_type: foodRecommendations?.target_meal_type ?? 'dinner',
                                      servings: 1,
                                      note: '首页快捷记录',
                                    });
                                  }}
                                  disabled={quickAddMealMutation.isPending}
                                >
                                  开始做
                                </button>
                                <button className="dashboard-icon-button" type="button" onClick={() => setActiveTab('foods')} aria-label="查看食物">
                                  <DashboardIcon name="list" />
                                </button>
                                <button
                                  className="dashboard-icon-button"
                                  type="button"
                                  onClick={() => openHomePlanAddDialog(food, foodRecommendations?.target_meal_type ?? 'dinner')}
                                  disabled={createFoodPlanItemMutation.isPending}
                                  aria-label={`加入菜单：${food.name}`}
                                  title="加入菜单"
                                >
                                  <DashboardIcon name="calendar" />
                                </button>
                              </div>
                            </div>
                          </article>
                        );
                      })}
                    </div>
                  ) : (
                    <EmptyState title="暂无推荐" description="补充食材或菜谱后，这里会出现今日建议。" />
                  )}
                </section>

                <div className="dashboard-lower-grid">
                  <div className="dashboard-lower-left">
                    <section className="card dashboard-panel dashboard-expiry-panel">
                      <div className="dashboard-panel-head">
                        <h2>临期优先处理</h2>
                        <button className="tertiary-button button-compact" type="button" onClick={openIngredientsCatalog}>
                          查看全部
                        </button>
                      </div>
                      <div className="dashboard-expiry-list" onScroll={handleExpiryListScroll}>
                        {visibleExpiringInventoryItems.length > 0 ? (
                          visibleExpiringInventoryItems.map((item) => {
                            const ingredient = ingredientById.get(item.ingredient_id);
                            const expiryBadge = getDashboardExpiryBadge(item.daysLeft);
                            return (
                              <article key={item.id} className="dashboard-expiry-item">
                                <div className="dashboard-ingredient-thumb">
                                  {ingredient?.image ? (
                                    <img
                                      src={resolveDashboardAssetUrl(ingredient.image.url)}
                                      alt={item.ingredient_name}
                                    />
                                  ) : (
                                    <span>{item.ingredient_name.slice(0, 1)}</span>
                                  )}
                                </div>
                                <div>
                                  <strong>{item.ingredient_name}</strong>
                                  <p>{item.storage_location || INVENTORY_STATUS_LABELS[item.status]}</p>
                                </div>
                                <Badge className={expiryBadge.className}>
                                  {expiryBadge.label}
                                </Badge>
                                <button
                                  className="solid-button button-compact"
                                  type="button"
                                  onClick={() =>
                                    item.daysLeft < 0
                                      ? openIngredientExpiredDisposal(item.ingredient_id)
                                      : openIngredientDetail(item.ingredient_id)
                                  }
                                >
                                  去处理
                                </button>
                              </article>
                            );
                          })
                        ) : (
                          <EmptyState title="没有临期食材" description="库存状态很稳，可以放心安排菜单。" />
                        )}
                        {visibleExpiryCount < expiringInventoryItems.length && (
                          <div className="dashboard-expiry-loading">继续下滑加载更多</div>
                        )}
                      </div>
                    </section>

                    <section className="card dashboard-panel dashboard-todo-panel">
                      <div className="dashboard-panel-head">
                        <h2>今日待办</h2>
                        <Badge>{dashboardCompletedCount} / {dashboardTodoItems.length || 0}</Badge>
                      </div>
                      <div className="dashboard-todo-list" onScroll={handleDashboardTodoListScroll}>
                        {dashboardTodoItems.length > 0 ? (
                          <>
                            {visibleDashboardTodoItems.map((item) => (
                              <button
                                key={item.id}
                                type="button"
                                className={item.done ? 'dashboard-todo-item done' : `dashboard-todo-item todo-${item.type}`}
                                onClick={() => handleDashboardTodoClick(item)}
                                aria-label={`${item.title}，${item.status}，点击处理`}
                              >
                                <span className="dashboard-todo-check">
                                  <DashboardIcon name={item.icon} />
                                </span>
                                <span className="dashboard-todo-copy">
                                  <strong>{item.title}</strong>
                                  <span>{item.description}</span>
                                </span>
                                <span className="dashboard-todo-meta">
                                  <Badge className={item.done ? 'dashboard-done-badge' : item.status === '紧急' ? 'dashboard-danger-badge' : 'dashboard-wait-badge'}>
                                    {item.status}
                                  </Badge>
                                  <small>{item.dateLabel}</small>
                                </span>
                                <span className="dashboard-todo-arrow" aria-hidden="true">
                                  <DashboardIcon name="chevron" />
                                </span>
                              </button>
                            ))}
                            {hasMoreDashboardTodoItems && (
                              <div className="dashboard-todo-loading">继续下滑加载更多</div>
                            )}
                          </>
                        ) : (
                          <EmptyState title="今日没有待办" description="新的临期、采购和餐食记录会自动出现在这里。" />
                        )}
                      </div>
                    </section>

                    <section className="card dashboard-panel dashboard-activity-panel">
                      <div className="dashboard-panel-head">
                        <h2>最近记录</h2>
                        <button className="tertiary-button button-compact" type="button" onClick={() => setActiveTab('logs')}>
                          查看全部
                        </button>
                      </div>
                      <div className="dashboard-activity-list">
                        {activityLogs.slice(0, 4).map((log, index) => {
                          const meal = recentMeals[index];
                          const plannedFood = foods.find((item) => item.id === foodPlanItems[index]?.food_id);
                          const imageUrl = meal?.photos[0]?.url ?? (plannedFood ? getFoodCover(plannedFood, recipes) : undefined);
                          return (
                            <article key={log.id} className="dashboard-activity-item">
                              <span className={`dashboard-activity-mark tone-${index % 4}`}>
                                {imageUrl ? (
                                  <img src={resolveDashboardAssetUrl(imageUrl)} alt="" />
                                ) : (
                                  <DashboardIcon name={index % 2 === 0 ? 'check' : 'calendar'} />
                                )}
                              </span>
                              <div>
                                <strong>{log.summary}</strong>
                                <p>{log.actor_name ?? '家庭成员'}</p>
                              </div>
                              <small>{formatDateTime(log.created_at)}</small>
                            </article>
                          );
                        })}
                        {activityLogs.length === 0 && <EmptyState title="暂无记录" description="开始记录餐食后，这里会展示厨房动态。" />}
                      </div>
                    </section>
                  </div>

                  <div className="dashboard-lower-right">
                    <section className="card dashboard-panel dashboard-week-panel">
                      <div className="dashboard-week-head">
                        <div className="dashboard-week-title">
                          <h2>本周菜单</h2>
                          <span>
                            <strong>{activeFoodPlanItems.length}</strong> / {dashboardWeekMealCapacity} 餐
                          </span>
                        </div>
                        <div className="dashboard-week-controls" aria-label="菜单周切换">
                          <button
                            className="dashboard-week-nav-button"
                            type="button"
                            onClick={() => setSelectedRecipePlanDate(addDateKeyDays(foodPlanWeekRange.start, -7))}
                          >
                            <DashboardIcon name="arrow-left" />
                            上一周
                          </button>
                          <button
                            className="dashboard-week-range-button"
                            type="button"
                            onClick={() => setSelectedRecipePlanDate(todayKey())}
                            title="回到本周"
                          >
                            <DashboardIcon name="calendar" />
                            {formatDashboardPlanRange(foodPlanWeekRange)}
                          </button>
                          <button
                            className="dashboard-week-nav-button"
                            type="button"
                            onClick={() => setSelectedRecipePlanDate(addDateKeyDays(foodPlanWeekRange.end, 1))}
                          >
                            下一周
                            <DashboardIcon name="arrow-right" />
                          </button>
                        </div>
                        <button className="dashboard-week-edit-button" type="button" onClick={() => setActiveTab('foods')}>
                          <DashboardIcon name="edit" />
                          编辑计划
                        </button>
                      </div>
                      <div className="dashboard-week-summary">
                        {dashboardPlanSummary.map((item) => (
                          <div key={item.label} className="dashboard-week-summary-item">
                            <span className={`dashboard-week-summary-icon tone-${item.tone}`}>
                              <DashboardIcon name={item.icon} />
                            </span>
                            <div>
                              <span>{item.label}</span>
                              <strong>{item.value}<small>餐</small></strong>
                            </div>
                          </div>
                        ))}
                      </div>
                      <div className="dashboard-week-grid">
                        {dashboardPlanDays.map((day) => (
                          <button
                            key={day.date}
                            className={[
                              'dashboard-day-card',
                              day.plannedMealCount > 0 ? 'filled' : '',
                              day.isToday ? 'today' : '',
                              day.isSelected ? 'selected' : '',
                            ]
                              .filter(Boolean)
                              .join(' ')}
                            type="button"
                            onClick={() => setSelectedDashboardPlanDate(day.date)}
                            aria-pressed={day.isSelected}
                          >
                            <span className="dashboard-day-weekday">{day.weekday}</span>
                            {day.isSelected && <span className="dashboard-day-selected-mark">{day.weekday}</span>}
                            <strong>{day.plannedMealCount}/{DASHBOARD_PLAN_MEAL_TYPES.length}</strong>
                            <small>{day.dayLabel}</small>
                            <div className="dashboard-day-meal-dots" aria-label="餐次安排状态">
                              {day.mealItems.map((meal) => (
                                <i
                                  key={meal.mealType}
                                  className={meal.items.length > 0 ? `is-filled meal-${meal.mealType}` : `meal-${meal.mealType}`}
                                  title={MEAL_TYPE_LABELS[meal.mealType]}
                                />
                              ))}
                            </div>
                          </button>
                        ))}
                      </div>
                      {selectedDashboardPlanDay && (
                        <div className="dashboard-plan-detail">
                          <div className="dashboard-plan-detail-head">
                            <strong>{selectedDashboardPlanDateLabel}</strong>
                            <span>{selectedDashboardPlanDay.totalCount} 项计划</span>
                          </div>
                          <div className="dashboard-plan-meal-list">
                            {selectedDashboardPlanDay.mealItems.map((meal) => (
                              <div
                                key={meal.mealType}
                                className={meal.items.length > 0 ? 'dashboard-plan-meal-row filled' : 'dashboard-plan-meal-row'}
                                title={meal.items.length > 0 ? `查看${MEAL_TYPE_LABELS[meal.mealType]}计划` : `添加${MEAL_TYPE_LABELS[meal.mealType]}计划`}
                              >
                                <span className={`dashboard-plan-meal-label meal-${meal.mealType}`}>
                                  <span className="dashboard-plan-meal-label-icon" aria-hidden="true">
                                    <DashboardMealIcon mealType={meal.mealType} />
                                  </span>
                                  <strong>{MEAL_TYPE_LABELS[meal.mealType]}</strong>
                                </span>
                                <span className="dashboard-plan-meal-copy">
                                  {meal.items.length > 0 ? (
                                    <span className="dashboard-plan-dish-list">
                                      {meal.items.slice(0, 4).map((item) => (
                                        (() => {
                                          const planFood = foods.find((food) => food.id === item.food_id);
                                          const planCoverUrl = resolveDashboardAssetUrl(planFood ? getFoodCover(planFood, recipes) : undefined);
                                          const planTitle = item.recipe_title || item.food_name || planFood?.name || '未命名食物';
                                          return (
                                            <button
                                              key={item.id}
                                              className={item.status === 'cooked' ? 'dashboard-plan-dish is-cooked' : 'dashboard-plan-dish'}
                                              type="button"
                                              onClick={() => openHomePlanDetail(item)}
                                              title={planTitle}
                                            >
                                              {planCoverUrl && <img src={planCoverUrl} alt="" />}
                                              <span>{planTitle}</span>
                                            </button>
                                          );
                                        })()
                                      ))}
                                      {meal.items.length > 4 && <span className="dashboard-plan-dish is-more">+{meal.items.length - 4}</span>}
                                    </span>
                                  ) : (
                                    <>
                                      <strong>未安排</strong>
                                      <small>去食物页添加计划</small>
                                    </>
                                  )}
                                </span>
                                <button
                                  className="dashboard-plan-meal-action"
                                  type="button"
                                  onClick={() => openHomePlanAddEmptyDialog(selectedDashboardPlanDay.date, meal.mealType)}
                                  aria-label={meal.items.length > 0 ? `查看${MEAL_TYPE_LABELS[meal.mealType]}计划` : `添加${MEAL_TYPE_LABELS[meal.mealType]}计划`}
                                >
                                  <DashboardIcon name="plus" />
                                </button>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                    </section>

                    <section className="card dashboard-panel dashboard-shopping-panel">
                      <div className="dashboard-panel-head">
                        <h2>采购提醒 <span>{pendingShoppingCount} 项待采购</span></h2>
                        <button className="tertiary-button button-compact" type="button" onClick={() => setActiveTab('ingredients')}>
                          查看清单
                        </button>
                      </div>
                      <div className="dashboard-shopping-row">
                        {pendingShoppingPreview.length > 0 ? (
                          pendingShoppingPreview.map((item) => {
                            const ingredient = findShoppingIngredient(item, ingredients);
                            const imageUrl = ingredient?.image?.url ? resolveDashboardAssetUrl(ingredient.image.url) : buildIngredientPlaceholderSvg(item.title);
                            return (
                              <button
                                key={item.id}
                                className="dashboard-shopping-pill"
                                type="button"
                                onClick={() => openHomeRestock(item)}
                                title={`登记库存：${item.title}`}
                              >
                                <span className="dashboard-shopping-image">
                                  <img src={imageUrl} alt="" />
                                </span>
                                <span className="dashboard-shopping-copy">
                                  <strong>{item.title}</strong>
                                  <p>{item.quantity}{item.unit}</p>
                                </span>
                              </button>
                            );
                          })
                        ) : (
                          <p className="subtle">采购清单已清空。</p>
                        )}
                      </div>
                    </section>
                  </div>
                </div>
              </div>
            </div>
          </main>
        )}

        {activeTab === 'foods' && (
          <FoodWorkspace
            foods={foods}
            recipes={recipes}
            ingredients={ingredients}
            inventoryItems={inventoryItems}
            mealLogs={mealLogs}
            foodRecommendations={foodRecommendations}
            foodScenes={foodScenes}
            foodPlanItems={foodPlanItems}
            foodPlanWeekRange={foodPlanWeekRange}
            createFood={(payload) => createFoodMutation.mutateAsync(payload)}
            updateFood={(foodId, payload) => updateFoodMutation.mutateAsync({ foodId, payload })}
            updateFoodFavorite={(foodId, favorite) => toggleFavoriteMutation.mutateAsync({ foodId, favorite })}
            quickAddMeal={(payload) => quickAddMealMutation.mutateAsync(payload)}
            createFoodPlanItem={(payload) => createFoodPlanItemMutation.mutateAsync(payload)}
            updateFoodPlanItem={(itemId, payload) => updateFoodPlanItemMutation.mutateAsync({ itemId, payload })}
            deleteFoodPlanItem={(itemId) => deleteFoodPlanItemMutation.mutateAsync(itemId)}
            createFoodScene={(payload) => createFoodSceneMutation.mutateAsync(payload)}
            updateFoodScene={(sceneId, payload) => updateFoodSceneMutation.mutateAsync({ sceneId, payload })}
            deleteFoodScene={(sceneId) => deleteFoodSceneMutation.mutateAsync(sceneId)}
            onOpenRecipes={() => setActiveTab('recipes')}
            onStartRecipe={(recipeId, foodPlanItemId) => {
              setPendingRecipeCookId(recipeId);
              setPendingFoodPlanCookItemId(foodPlanItemId ?? null);
              setActiveTab('recipes');
            }}
            onOpenLogs={() => setActiveTab('logs')}
            onFoodPlanPreviousWeek={() => setSelectedRecipePlanDate(addDateKeyDays(foodPlanWeekRange.start, -7))}
            onFoodPlanCurrentWeek={() => setSelectedRecipePlanDate(todayKey())}
            onFoodPlanNextWeek={() => setSelectedRecipePlanDate(addDateKeyDays(foodPlanWeekRange.end, 1))}
            isSavingFood={createFoodMutation.isPending || updateFoodMutation.isPending}
            isUpdatingFavorite={toggleFavoriteMutation.isPending}
            isQuickAdding={quickAddMealMutation.isPending}
            isUpdatingPlan={createFoodPlanItemMutation.isPending || updateFoodPlanItemMutation.isPending || deleteFoodPlanItemMutation.isPending}
            isUpdatingScene={createFoodSceneMutation.isPending || updateFoodSceneMutation.isPending || deleteFoodSceneMutation.isPending}
          />
        )}

        {activeTab === 'recipes' && (
          <main className="page-stack">
            <RecipeWorkspace
              recipes={recipes}
              ingredients={ingredients}
              inventoryItems={inventoryItems}
              mealLogs={mealLogs}
              foods={foods}
              shoppingItems={shoppingItems}
              recipeFavorites={recipeFavorites}
              recipeDiscovery={recipeDiscovery}
              recipeStats={recipeStats}
              recipePlanItems={[]}
              recipeScenes={foodScenes}
              recipePlanWeekRange={foodPlanWeekRange}
              startRecipeId={pendingRecipeCookId}
              startFoodPlanItemId={pendingFoodPlanCookItemId}
              onStartRecipeHandled={() => {
                setPendingRecipeCookId(null);
                setPendingFoodPlanCookItemId(null);
              }}
              onRecipePlanPreviousWeek={() => setSelectedRecipePlanDate(addDateKeyDays(foodPlanWeekRange.start, -7))}
              onRecipePlanCurrentWeek={() => setSelectedRecipePlanDate(todayKey())}
              onRecipePlanNextWeek={() => setSelectedRecipePlanDate(addDateKeyDays(foodPlanWeekRange.end, 1))}
              createRecipe={(payload) => createRecipeMutation.mutateAsync(payload)}
              updateRecipe={(recipeId, payload) => updateRecipeMutation.mutateAsync({ recipeId, payload })}
              deleteRecipe={(recipeId) => deleteRecipeMutation.mutateAsync(recipeId)}
              cookRecipe={(recipeId, payload) => cookRecipeMutation.mutateAsync({ recipeId, payload })}
              previewCookRecipe={(recipeId, payload) => previewCookRecipeMutation.mutateAsync({ recipeId, payload })}
              generateRecipeDraft={(payload) => api.generateRecipeDraft(payload)}
              createShoppingItem={(payload) => createShoppingMutation.mutateAsync(payload)}
              addRecipeFavorite={(recipeId) => addRecipeFavoriteMutation.mutateAsync(recipeId)}
              removeRecipeFavorite={(recipeId) => removeRecipeFavoriteMutation.mutateAsync(recipeId)}
              createRecipePlanItem={async () => {
                throw new Error('菜单计划已迁移到食物页');
              }}
              updateRecipePlanItem={async () => {
                throw new Error('菜单计划已迁移到食物页');
              }}
              deleteRecipePlanItem={async () => {
                throw new Error('菜单计划已迁移到食物页');
              }}
              createRecipeScene={(payload) => createFoodSceneMutation.mutateAsync(payload)}
              updateRecipeScene={(sceneId, payload) => updateFoodSceneMutation.mutateAsync({ sceneId, payload })}
              deleteRecipeScene={(sceneId) => deleteFoodSceneMutation.mutateAsync(sceneId)}
              isCreatingRecipe={createRecipeMutation.isPending}
              isUpdatingRecipe={updateRecipeMutation.isPending}
              isDeletingRecipe={deleteRecipeMutation.isPending}
              isCookingRecipe={cookRecipeMutation.isPending}
              isCreatingShopping={createShoppingMutation.isPending}
              isUpdatingFavorite={addRecipeFavoriteMutation.isPending || removeRecipeFavoriteMutation.isPending}
              isUpdatingPlan={
                createFoodPlanItemMutation.isPending ||
                updateFoodPlanItemMutation.isPending ||
                deleteFoodPlanItemMutation.isPending
              }
              isUpdatingScene={
                createFoodSceneMutation.isPending ||
                updateFoodSceneMutation.isPending ||
                deleteFoodSceneMutation.isPending
              }
            />
          </main>
        )}

        {activeTab === 'ingredients' && (
          <IngredientWorkspace
            ingredients={ingredients}
            inventoryItems={inventoryItems}
            shoppingItems={shoppingItems}
            recipes={recipes}
            navigationRequest={ingredientNavigationRequest}
            createIngredient={(payload) => createIngredientMutation.mutateAsync(payload)}
            updateIngredient={(ingredientId, payload) => updateIngredientMutation.mutateAsync({ ingredientId, payload })}
            createInventory={(payload) => createInventoryMutation.mutateAsync(payload)}
            consumeInventory={(payload) => consumeInventoryMutation.mutateAsync(payload)}
            disposeExpiredInventory={(payload) => disposeExpiredInventoryMutation.mutateAsync(payload)}
            createShoppingItem={(payload) => createShoppingMutation.mutateAsync(payload)}
            updateShoppingItem={(payload) => updateShoppingMutation.mutateAsync(payload)}
            isCreatingIngredient={createIngredientMutation.isPending}
            isUpdatingIngredient={updateIngredientMutation.isPending}
            isCreatingInventory={createInventoryMutation.isPending}
            isConsumingInventory={consumeInventoryMutation.isPending}
            isDisposingExpiredInventory={disposeExpiredInventoryMutation.isPending}
            isCreatingShopping={createShoppingMutation.isPending}
            isUpdatingShopping={updateShoppingMutation.isPending}
          />
        )}

        {activeTab === 'logs' && (
          <main className="page-stack">
            <PageHeader
              variant="compact"
              eyebrow="记录"
              title="记录今天吃了什么"
              description="记录完成后，库存建议会跟着这顿饭一起留下。"
            />
            <div className="page-columns page-columns-split">
              <section className="card page-section page-main-column">
                <SectionHeading title="新记录" description="支持多人参与、食物选择和图片上传" />
                <form className="form-grid" onSubmit={submitMeal}>
                  <section className="form-panel-section span-two">
                    <div className="section-mini-title">基础信息</div>
                    <div className="form-grid nested-grid">
                      <label>
                        <span>日期</span>
                        <input
                          className="text-input"
                          type="date"
                          value={mealForm.date}
                          onChange={(event) => setMealForm({ ...mealForm, date: event.target.value })}
                        />
                      </label>
                      <label>
                        <span>餐别</span>
                        <select
                          className="text-input"
                          value={mealForm.mealType}
                          onChange={(event) =>
                            setMealForm({ ...mealForm, mealType: event.target.value as MealType })
                          }
                        >
                          {Object.entries(MEAL_TYPE_LABELS).map(([key, label]) => (
                            <option key={key} value={key}>
                              {label}
                            </option>
                          ))}
                        </select>
                      </label>
                    </div>
                  </section>

                  <section className="form-panel-section span-two">
                    <div className="section-mini-title">本餐食物</div>
                    <div className="selection-list">
                      {foods.map((food) => {
                        const selected = mealFoodEntries.find((item) => item.food_id === food.id);
                        return (
                          <div key={food.id} className="selection-card">
                            <label className="checkbox-row">
                              <input
                                type="checkbox"
                                checked={Boolean(selected)}
                                onChange={(event) =>
                                  handleMealFoodToggle(food.id, event.target.checked)
                                }
                              />
                              <span>{food.name}</span>
                            </label>
                            {selected && (
                              <div className="selection-details">
                                <input
                                  className="text-input"
                                  type="number"
                                  min="0.5"
                                  step="0.5"
                                  value={selected.servings}
                                  onChange={(event) =>
                                    updateMealFood(food.id, 'servings', event.target.value)
                                  }
                                />
                                <input
                                  className="text-input"
                                  placeholder="这道菜的备注"
                                  value={selected.note}
                                  onChange={(event) => updateMealFood(food.id, 'note', event.target.value)}
                                />
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </section>

                  <section className="form-panel-section span-two">
                    <div className="section-mini-title">共同就餐成员</div>
                    <div className="member-row">
                      {members.map((member) => (
                        <label key={member.id} className="checkbox-row member-pill">
                          <input
                            type="checkbox"
                            checked={selectedParticipants.includes(member.id)}
                            onChange={(event) => updateParticipant(member.id, event.target.checked)}
                          />
                          <span>{member.display_name}</span>
                        </label>
                      ))}
                    </div>
                  </section>

                  <section className="form-panel-section span-two">
                    <div className="section-mini-title">补充信息</div>
                    <div className="form-grid nested-grid">
                      <label>
                        <span>满意度</span>
                        <input
                          className="text-input"
                          value={mealForm.mood}
                          onChange={(event) => setMealForm({ ...mealForm, mood: event.target.value })}
                        />
                      </label>
                      <label className="span-two">
                        <span>备注</span>
                        <textarea
                          className="text-input"
                          rows={3}
                          value={mealForm.notes}
                          onChange={(event) => setMealForm({ ...mealForm, notes: event.target.value })}
                        />
                      </label>
                    </div>
                  </section>

                  <ImageComposer
                    title="餐食照片"
                    value={mealForm.photos}
                    previewLabel="餐食照片"
                    onUpload={(files) =>
                      void handleImageUpload(files, mealImagePayload, (next) => setMealForm({ ...mealForm, photos: next }), setMealImageState)
                    }
                    onGenerate={(mode) =>
                      void handleGenerateImage(mode, mealForm.photos, mealImagePayload, (next) => setMealForm({ ...mealForm, photos: next }), setMealImageState)
                    }
                    onReset={() => resetImageInput((value) => setMealForm({ ...mealForm, photos: value }), setMealImageState)}
                    isGenerating={mealImageState.isGenerating}
                    errorMessage={mealImageState.errorMessage}
                  />

                  <div className="span-two form-actions">
                    <button className="solid-button" type="submit" disabled={mealSubmitDisabled}>
                      {createMealMutation.isPending ? '保存中...' : mealImageState.isGenerating ? '生成主图中...' : '保存餐食记录'}
                    </button>
                  </div>
                </form>
              </section>

              <aside className="card page-section page-side-column">
                <SectionHeading title="最近记录" description="最近的餐食记录会持续保留在这里" />
                <div className="stack-list">
                  {recentMeals.map((meal) => (
                    <article key={meal.id} className="meal-card">
                      <div className="inline-between">
                        <div>
                          <h3>
                            {formatDate(meal.date)} · {MEAL_TYPE_LABELS[meal.meal_type]}
                          </h3>
                          <p>{meal.food_entries.map((entry) => entry.food_name).join('、')}</p>
                        </div>
                        <Badge>{meal.mood}</Badge>
                      </div>
                      <p className="subtle">{meal.notes || '没有额外备注'}</p>
                      {meal.deduction_suggestions.length > 0 && (
                        <div className="tag-row">
                          {meal.deduction_suggestions.map((item) => (
                            <Badge key={item.id}>
                              {item.ingredient_name} {item.suggested_amount}
                              {item.unit}
                            </Badge>
                          ))}
                        </div>
                      )}
                    </article>
                  ))}
                </div>
              </aside>
            </div>
          </main>
        )}

        {activeTab === 'ai' && (
          <main className="page-stack">
            <PageHeader
              variant="compact"
              eyebrow="AI"
              title="围绕这个家庭的库存和菜谱提问"
              description="只保留对这个厨房有帮助的问答和建议。"
            />
            <div className="page-columns page-columns-split">
              <section className="card page-section page-main-column">
                <SectionHeading title="提问面板" description="选择模式后，用一句话说明你要解决的问题" />
                <form className="form-grid" onSubmit={submitAi}>
                  <section className="form-panel-section span-two">
                    <div className="section-mini-title">对话设置</div>
                    <div className="form-grid nested-grid">
                      <label>
                        <span>能力模式</span>
                        <select
                          className="text-input"
                          value={aiMode}
                          onChange={(event) => setAiMode(event.target.value as AiMode)}
                        >
                          {Object.entries(AI_MODE_LABELS).map(([key, label]) => (
                            <option key={key} value={key}>
                              {label}
                            </option>
                          ))}
                        </select>
                      </label>
                      {aiMode === 'foodQa' && (
                        <label>
                          <span>选择菜品</span>
                          <select
                            className="text-input"
                            value={aiFoodId}
                            onChange={(event) => setAiFoodId(event.target.value)}
                          >
                            <option value="">请选择一个食物</option>
                            {foods.map((food) => (
                              <option key={food.id} value={food.id}>
                                {food.name}
                              </option>
                            ))}
                          </select>
                        </label>
                      )}
                      <label className="span-two">
                        <span>问题 / 指令</span>
                        <textarea
                          className="text-input"
                          rows={3}
                          value={aiPrompt}
                          onChange={(event) => setAiPrompt(event.target.value)}
                        />
                      </label>
                    </div>
                  </section>
                  {aiMode === 'recipeDraft' && (
                    <section className="form-panel-section span-two">
                      <div className="section-mini-title">选择现有食材</div>
                      <div className="member-row">
                        {ingredients.map((ingredient) => (
                          <label key={ingredient.id} className="checkbox-row member-pill">
                            <input
                              type="checkbox"
                              checked={selectedAiIngredientIds.includes(ingredient.id)}
                              onChange={(event) =>
                                updateAiIngredients(ingredient.id, event.target.checked)
                              }
                            />
                            <span>{ingredient.name}</span>
                          </label>
                        ))}
                      </div>
                    </section>
                  )}
                  <div className="span-two form-actions">
                    <button className="solid-button" type="submit">
                      发送给 AI
                    </button>
                  </div>
                </form>
              </section>

              <aside className="card page-section page-side-column">
                <SectionHeading title="结果面板" description="保留本家庭最近的 AI 对话与建议" />
                <div className="stack-list">
                  {aiConversations.length > 0 ? (
                    aiConversations.map((item) => (
                      <article key={item.id} className="conversation-card">
                        <div className="inline-between">
                          <h3>{AI_MODE_LABELS[item.mode]}</h3>
                          <span className="subtle">{formatDateTime(item.created_at)}</span>
                        </div>
                        <p className="prompt-line">你问：{item.prompt}</p>
                        <p>{item.response}</p>
                      </article>
                    ))
                  ) : (
                      <EmptyState
                        title="还没有 AI 对话"
                        description="可以先从库存问答或今晚吃什么开始。"
                      />
                    )}
                  </div>
                </aside>
              </div>
          </main>
        )}

        {activeTab === 'family' && (
          <main className="page-stack">
            <PageHeader
              variant="compact"
              eyebrow="我的家庭"
              title="管理成员、邀请和活动流"
              description="成员信息和活动流留在主页面，创建成员账号收进统一弹窗。"
              actions={
                isOwner ? (
                  <div className="hero-actions">
                    <ActionButton tone="primary" type="button" onClick={() => setFamilyOverlayMode('invite')}>
                      创建成员账号
                    </ActionButton>
                  </div>
                ) : undefined
              }
            />

            <section className="card page-section">
              <SectionHeading title="家庭成员" description="查看成员身份、账号和协作角色" />
              <div className="member-grid">
                {members.map((member) => (
                  <article key={member.id} className="member-card">
                    <Avatar label={member.display_name} seed={member.avatar_seed} large />
                    <div>
                      <h3>{member.display_name}</h3>
                      <p className="subtle">
                        {member.role} · {member.username}
                      </p>
                      <p className="subtle">{member.email ?? '未填写邮箱'}</p>
                    </div>
                  </article>
                ))}
              </div>
            </section>

            <section className="card page-section">
              <SectionHeading title="活动流" description="最近的厨房操作都会留在这里" />
              <div className="stack-list">
                {activityLogs.map((log) => (
                  <article key={log.id} className="activity-row">
                    <Avatar label={log.actor_name ?? '成员'} seed={log.actor_name ?? '成员'} />
                    <div>
                      <p>
                        <strong>{log.actor_name ?? '家庭成员'}</strong> {log.summary}
                      </p>
                      <span className="subtle">{formatDateTime(log.created_at)}</span>
                    </div>
                  </article>
                ))}
              </div>
            </section>

            {familyOverlayMode === 'invite' && (
              <div className="workspace-overlay-root">
                <div className="workspace-overlay-backdrop" onClick={() => setFamilyOverlayMode(null)} />
                <WorkspaceModal
                  title="创建成员账号"
                  description="为家庭成员开通登录账号，完成后会立即出现在成员列表中。"
                  onClose={() => setFamilyOverlayMode(null)}
                >
                  <form className="form-grid compact-grid" onSubmit={submitInvite}>
                    <label>
                      <span>用户名</span>
                      <input
                        className="text-input"
                        value={inviteForm.username}
                        onChange={(event) =>
                          setInviteForm({ ...inviteForm, username: event.target.value })
                        }
                      />
                    </label>
                    <label>
                      <span>显示名称</span>
                      <input
                        className="text-input"
                        value={inviteForm.displayName}
                        onChange={(event) =>
                          setInviteForm({ ...inviteForm, displayName: event.target.value })
                        }
                      />
                    </label>
                    <label>
                      <span>初始密码</span>
                      <input
                        className="text-input"
                        type="password"
                        value={inviteForm.password}
                        onChange={(event) =>
                          setInviteForm({ ...inviteForm, password: event.target.value })
                        }
                      />
                    </label>
                    <label>
                      <span>角色</span>
                      <select
                        className="text-input"
                        value={inviteForm.role}
                        onChange={(event) =>
                          setInviteForm({
                            ...inviteForm,
                            role: event.target.value as 'Owner' | 'Member',
                          })
                        }
                      >
                        <option value="Member">Member</option>
                        <option value="Owner">Owner</option>
                      </select>
                    </label>
                    <label className="span-two">
                      <span>邮箱</span>
                      <input
                        className="text-input"
                        type="email"
                        value={inviteForm.email}
                        onChange={(event) => setInviteForm({ ...inviteForm, email: event.target.value })}
                      />
                    </label>
                    <div className="span-two workspace-overlay-actions">
                      <ActionButton
                        tone="secondary"
                        type="button"
                        onClick={() => setFamilyOverlayMode(null)}
                        disabled={createMemberMutation.isPending}
                      >
                        取消
                      </ActionButton>
                      <ActionButton tone="primary" type="submit" disabled={createMemberMutation.isPending}>
                        {createMemberMutation.isPending ? '创建中...' : '创建成员账号'}
                      </ActionButton>
                    </div>
                  </form>
                </WorkspaceModal>
              </div>
            )}
          </main>
        )}

        {homePlanDetailItem && (
          <FoodPlanDetailModal
            item={homePlanDetailItem}
            food={homePlanDetailFood}
            recipes={recipes}
            form={homePlanDetailForm}
            isEditing={isHomePlanDetailEditing}
            isUpdatingPlan={updateFoodPlanItemMutation.isPending || deleteFoodPlanItemMutation.isPending}
            isCompleting={cookRecipeMutation.isPending || quickAddMealMutation.isPending}
            onClose={closeHomePlanDetail}
            onChangeForm={setHomePlanDetailForm}
            onEditingChange={setIsHomePlanDetailEditing}
            onResetEdit={resetHomePlanDetailForm}
            onSubmit={(event) => void submitHomePlanDetail(event)}
            onComplete={() => void startHomePlanDetailCook(homePlanDetailItem)}
            onDelete={() => void deleteHomePlanDetail(homePlanDetailItem)}
            resolveAssetUrl={(url) => resolveDashboardAssetUrl(url) ?? url}
          />
        )}

        {isHomePlanAddDialogOpen && (
          <div className="workspace-overlay-root">
            <div className="workspace-overlay-backdrop" onClick={closeHomePlanAddDialog} />
            <WorkspaceModal
              title="加食物到菜单"
              description="选择日期和餐次后加入当前周菜单。"
              eyebrow="菜单计划"
              onClose={closeHomePlanAddDialog}
              className="recipe-plan-modal food-plan-modal"
            >
              <form className="recipe-plan-dialog-form" onSubmit={(event) => void submitHomePlanAdd(event)}>
                {homePlanAddFood ? (
                  <div className="recipe-plan-dialog-hero">
                    <div className="recipe-plan-selected-cover">
                      {getFoodCover(homePlanAddFood, recipes) ? (
                        <img src={resolveDashboardAssetUrl(getFoodCover(homePlanAddFood, recipes))} alt={homePlanAddFood.name} />
                      ) : (
                        <div className="recipe-plan-cover-empty">{homePlanAddFood.name.slice(0, 2)}</div>
                      )}
                    </div>
                    <div className="recipe-plan-selected-copy">
                      <span className="recipe-plan-dialog-kicker">即将加入</span>
                      <strong>{homePlanAddFood.name}</strong>
                      <div className="recipe-plan-selected-meta">
                        <span>
                          <DashboardIcon name="list" />
                          {FOOD_TYPE_LABELS[homePlanAddFood.type]}
                        </span>
                        <span>
                          <DashboardIcon name="calendar" />
                          {homePlanAddFood.source_name || homePlanAddFood.purchase_source || homePlanAddFood.category || '常吃食物'}
                        </span>
                        <span>
                          <DashboardIcon name={homePlanAddFood.recipe_id ? 'pot' : 'receipt'} />
                          {homePlanAddFood.recipe_id ? '关联菜谱' : '可直接记录'}
                        </span>
                      </div>
                    </div>
                    <button className="recipe-plan-change-food" type="button" onClick={() => setHomePlanAddFoodId(null)}>
                      修改
                    </button>
                  </div>
                ) : (
                  <div className="recipe-plan-picker">
                    <label htmlFor="home-food-plan-search">选择食物</label>
                    <div className="recipe-plan-combobox">
                      <DashboardIcon name="list" />
                      <input
                        id="home-food-plan-search"
                        className="recipe-plan-search-input"
                        value={homePlanAddFoodSearch}
                        placeholder="搜索食物、来源、场景或备注"
                        onChange={(event) => setHomePlanAddFoodSearch(event.target.value)}
                      />
                    </div>
                    <div className="recipe-plan-option-panel">
                      {homePlanAddFoodOptions.length > 0 ? (
                        homePlanAddFoodOptions.map((food) => {
                          const cover = getFoodCover(food, recipes);
                          return (
                            <button
                              key={food.id}
                              type="button"
                              className="recipe-plan-option"
                              onClick={() => selectHomePlanAddFood(food)}
                            >
                              <span className="recipe-plan-option-cover recipe-work-cover">
                                {cover ? <img src={resolveDashboardAssetUrl(cover)} alt="" /> : <span>{food.name.slice(0, 2)}</span>}
                              </span>
                              <span>
                                <strong>{food.name}</strong>
                                <small>{[FOOD_TYPE_LABELS[food.type], food.source_name || food.purchase_source || food.category, food.recipe_id ? '可开始做' : '可记到今天'].filter(Boolean).join(' · ')}</small>
                              </span>
                              <Badge className="recipe-plan-option-status">{MEAL_TYPE_LABELS[getDefaultHomePlanMealType(food, homePlanAddForm.mealType)]}</Badge>
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
                      {dashboardPlanDays.map((day) => (
                        <button
                          key={day.date}
                          type="button"
                          className={homePlanAddForm.planDate === day.date ? 'active' : ''}
                          aria-pressed={homePlanAddForm.planDate === day.date}
                          onClick={() => setHomePlanAddForm((current) => ({ ...current, planDate: day.date }))}
                        >
                          <span>{day.isToday ? '今天' : `周${day.weekday}`}</span>
                          <strong>{day.date.slice(5).replace('-', '/')}</strong>
                        </button>
                      ))}
                    </div>
                  </label>
                  <label className="recipe-plan-meal-field">
                    <span>餐次</span>
                    <div className="recipe-plan-meal-segment" role="radiogroup" aria-label="餐次">
                      {DASHBOARD_PLAN_MEAL_TYPES.map((mealType) => (
                        <button
                          key={mealType}
                          type="button"
                          className={homePlanAddForm.mealType === mealType ? 'active' : ''}
                          aria-pressed={homePlanAddForm.mealType === mealType}
                          onClick={() => setHomePlanAddForm((current) => ({ ...current, mealType }))}
                        >
                          {MEAL_TYPE_LABELS[mealType]}
                        </button>
                      ))}
                    </div>
                  </label>
                </div>
                <label className="recipe-plan-note-field">
                  <span>备注</span>
                  <input
                    className="text-input"
                    value={homePlanAddForm.note}
                    placeholder="比如：少油、常点套餐、提前解冻"
                    onChange={(event) => setHomePlanAddForm((current) => ({ ...current, note: event.target.value }))}
                  />
                </label>
                <div className="workspace-overlay-actions">
                  <ActionButton tone="primary" type="submit" disabled={createFoodPlanItemMutation.isPending || !homePlanAddFood}>
                    {createFoodPlanItemMutation.isPending ? '加入中...' : '加入菜单'}
                  </ActionButton>
                  <ActionButton tone="secondary" type="button" onClick={closeHomePlanAddDialog}>
                    取消
                  </ActionButton>
                </div>
              </form>
            </WorkspaceModal>
          </div>
        )}

        {homeExpiryReviewItem && (
          <div className="workspace-overlay-root">
            <div className="workspace-overlay-backdrop" onClick={closeHomeExpiryReview} />
            <WorkspaceModal
              title="处理临期食材"
              description="先核对这批库存的信息；需要调整数量、位置或继续处理时进入食材详情。"
              closeLabel="×"
              closeAriaLabel="关闭"
              className="dashboard-todo-modal"
              onClose={closeHomeExpiryReview}
            >
              <div className="dashboard-todo-dialog">
                <section className="dashboard-todo-dialog-hero">
                  <div className="dashboard-todo-dialog-media">
                    {homeExpiryReviewIngredient?.image?.url ? (
                      <img
                        src={resolveDashboardAssetUrl(homeExpiryReviewIngredient.image.url)}
                        alt={homeExpiryReviewIngredient.name}
                      />
                    ) : (
                      <span>{homeExpiryReviewItem.ingredient_name.slice(0, 1)}</span>
                    )}
                  </div>
                  <div className="dashboard-todo-dialog-copy">
                    <Badge className={homeExpiryReviewItem.daysLeft <= 1 ? 'dashboard-danger-badge' : 'dashboard-wait-badge'}>
                      {homeExpiryReviewItem.daysLeft <= 0 ? '今天到期' : formatRelativeDays(homeExpiryReviewItem.expiry_date ?? today)}
                    </Badge>
                    <h3>{homeExpiryReviewItem.ingredient_name}</h3>
                    <p>
                      {homeExpiryReviewIngredient?.category || '未分类'} · {homeExpiryReviewItem.storage_location || '未记录位置'}
                    </p>
                  </div>
                </section>

                <div className="dashboard-todo-dialog-grid">
                  <article>
                    <span>剩余数量</span>
                    <strong>{homeExpiryReviewItem.remaining_quantity ?? homeExpiryReviewItem.quantity}{homeExpiryReviewItem.unit}</strong>
                  </article>
                  <article>
                    <span>库存状态</span>
                    <strong>{INVENTORY_STATUS_LABELS[homeExpiryReviewItem.status]}</strong>
                  </article>
                  <article>
                    <span>购买日期</span>
                    <strong>{formatDate(homeExpiryReviewItem.purchase_date)}</strong>
                  </article>
                  <article>
                    <span>到期日期</span>
                    <strong>{homeExpiryReviewItem.expiry_date ? formatDate(homeExpiryReviewItem.expiry_date) : '未记录'}</strong>
                  </article>
                </div>

                {homeExpiryReviewItem.notes && (
                  <p className="dashboard-todo-dialog-note">{homeExpiryReviewItem.notes}</p>
                )}

                <div className="workspace-overlay-actions">
                  <ActionButton
                    tone="primary"
                    type="button"
                    onClick={() => {
                      const ingredientId = homeExpiryReviewItem.ingredient_id;
                      closeHomeExpiryReview();
                      openIngredientDetail(ingredientId);
                    }}
                  >
                    查看食材详情
                  </ActionButton>
                  <ActionButton tone="secondary" type="button" onClick={closeHomeExpiryReview}>
                    关闭
                  </ActionButton>
                </div>
              </div>
            </WorkspaceModal>
          </div>
        )}

        {homeMealDetail && (
          <div className="workspace-overlay-root">
            <div className="workspace-overlay-backdrop" onClick={closeHomeMealDetail} />
            <WorkspaceModal
              title="餐食详情"
              description="这条今日待办已经完成，下面是本餐记录。"
              closeLabel="×"
              closeAriaLabel="关闭"
              className="dashboard-todo-modal meal-detail-modal"
              onClose={closeHomeMealDetail}
            >
              <div className="dashboard-todo-dialog meal-detail-dialog">
                <section className="meal-detail-head">
                  <div>
                    <Badge className="dashboard-done-badge">已完成</Badge>
                    <h3>{MEAL_TYPE_LABELS[homeMealDetail.meal_type]}</h3>
                    <p>{formatDate(homeMealDetail.date)} · {formatDateTime(homeMealDetail.created_at)}</p>
                  </div>
                  {homeMealDetail.mood && <strong>{homeMealDetail.mood}</strong>}
                </section>

                <section className="meal-detail-section">
                  <span>本餐食物</span>
                  <div className="meal-detail-food-list">
                    {homeMealDetail.food_entries.length > 0 ? (
                      homeMealDetail.food_entries.map((entry) => (
                        <article key={entry.id} className="meal-detail-food-item">
                          <div>
                            <strong>{entry.food_name}</strong>
                            {entry.note && <p>{entry.note}</p>}
                          </div>
                          <Badge>{entry.servings} 份</Badge>
                        </article>
                      ))
                    ) : (
                      <p className="subtle">这餐没有关联具体食物。</p>
                    )}
                  </div>
                </section>

                <section className="meal-detail-section">
                  <span>参与成员</span>
                  <div className="meal-detail-member-row">
                    {homeMealDetailParticipants.length > 0 ? (
                      homeMealDetailParticipants.map((member) => (
                        <span key={member.id} className="meal-detail-member">
                          <Avatar label={member.display_name} seed={member.avatar_seed} />
                          {member.display_name}
                        </span>
                      ))
                    ) : (
                      <p className="subtle">未记录参与成员。</p>
                    )}
                  </div>
                </section>

                {homeMealDetail.notes && (
                  <section className="meal-detail-section">
                    <span>备注</span>
                    <p className="meal-detail-note">{homeMealDetail.notes}</p>
                  </section>
                )}

                {homeMealDetail.photos.length > 0 && (
                  <section className="meal-detail-section">
                    <span>照片</span>
                    <div className="meal-detail-photo-grid">
                      {homeMealDetail.photos.map((photo) => (
                        <img key={photo.id} src={resolveDashboardAssetUrl(photo.url)} alt={photo.alt || photo.name} />
                      ))}
                    </div>
                  </section>
                )}

                <div className="workspace-overlay-actions">
                  <ActionButton tone="primary" type="button" onClick={closeHomeMealDetail}>
                    知道了
                  </ActionButton>
                </div>
              </div>
            </WorkspaceModal>
          </div>
        )}

        {homeRestockShoppingItem && homeRestockForm && (
          <div className="workspace-overlay-root">
            <div className="workspace-overlay-backdrop" onClick={closeHomeRestock} />
            <WorkspaceModal
              title="登记这批库存"
              description="从首页采购提醒快速入库，保存后会把这条采购项标记完成。"
              closeLabel="×"
              closeAriaLabel="关闭"
              className="workspace-modal-wide inventory-restock-modal"
              onClose={closeHomeRestock}
            >
              <form className="ingredients-restock-form" onSubmit={(event) => void submitHomeRestock(event)}>
                <div className="ingredients-restock-scroll">
                  <div className="ingredients-restock-source-note">
                    <Badge>来自采购提醒</Badge>
                    <span>{homeRestockShoppingItem.title}</span>
                  </div>

                  <section className="ingredients-restock-identity-card">
                    <div className="ingredients-restock-identity-media">
                      <img
                        src={homeRestockIngredientImageUrl ?? buildIngredientPlaceholderSvg(homeRestockShoppingItem.title)}
                        alt={homeRestockIngredient?.name ?? homeRestockShoppingItem.title}
                      />
                    </div>
                    <div className="ingredients-restock-identity-copy">
                      <div className="ingredients-restock-identity-head">
                        <div>
                          <h4>{homeRestockIngredient?.name ?? (homeRestockForm.ingredientQuery || homeRestockShoppingItem.title)}</h4>
                          <p>
                            {homeRestockIngredient
                              ? `${homeRestockIngredient.category || '未分类'} · 默认 ${homeRestockIngredient.default_unit || '个'} · ${homeRestockIngredient.default_storage || '冷藏'}`
                              : '先匹配一份食材档案'}
                          </p>
                        </div>
                        <Badge>{homeRestockIngredient ? '已匹配食材' : '待匹配'}</Badge>
                      </div>
                    </div>
                  </section>

                  <label className="ingredients-restock-search-field">
                    <span>食材</span>
                    <input
                      className="text-input"
                      list="home-restock-ingredient-options"
                      placeholder="搜索或选择食材"
                      value={homeRestockForm.ingredientQuery}
                      onChange={(event) => {
                        const nextQuery = event.target.value;
                        const ingredient = ingredients.find((item) => item.name === nextQuery) ?? null;
                        const nextStorage = ingredient?.default_storage || homeRestockForm.storageLocation || '冷藏';
                        const nextExpiryMode = ingredient?.default_expiry_mode ?? homeRestockForm.expiryInputMode;
                        const nextExpiryDays =
                          nextExpiryMode === 'days'
                            ? ingredient?.default_expiry_days
                              ? String(ingredient.default_expiry_days)
                              : homeRestockForm.expiryDays || '3'
                            : '';
                        updateHomeRestockForm({
                          ...homeRestockForm,
                          ingredientId: ingredient?.id ?? '',
                          ingredientQuery: nextQuery,
                          unit: ingredient?.default_unit || homeRestockForm.unit,
                          storageLocation: nextStorage,
                          status: resolveInventoryStatusForStorage(nextStorage),
                          expiryInputMode: nextExpiryMode,
                          expiryDays: nextExpiryDays,
                          expiryDate:
                            nextExpiryMode === 'days'
                              ? resolveExpiryDateFromDays(homeRestockForm.purchaseDate, nextExpiryDays)
                              : '',
                        });
                      }}
                    />
                    <datalist id="home-restock-ingredient-options">
                      {ingredients.map((ingredient) => (
                        <option key={ingredient.id} value={ingredient.name} />
                      ))}
                    </datalist>
                  </label>

                  <section className="ingredients-restock-field-group ingredients-restock-quantity-section">
                    <div className="form-grid compact-grid">
                      <label>
                        <span>数量</span>
                        <input
                          className="text-input"
                          type="number"
                          min="0.01"
                          step="0.01"
                          value={homeRestockForm.quantity}
                          onChange={(event) => updateHomeRestockForm({ ...homeRestockForm, quantity: event.target.value })}
                        />
                      </label>
                      <label>
                        <span>单位</span>
                        <input
                          className="text-input"
                          value={homeRestockForm.unit}
                          onChange={(event) => updateHomeRestockForm({ ...homeRestockForm, unit: event.target.value })}
                        />
                      </label>
                    </div>
                  </section>

                  <section className="ingredients-restock-field-group">
                    <div className="ingredients-restock-field-head">
                      <span>购买时间</span>
                      <p className="subtle">默认今天，需要时再改。</p>
                    </div>
                    <div className="ingredients-restock-choice-row">
                      {[
                        { label: '今天', date: todayKey() },
                        { label: '昨天', date: shiftDateKey(todayKey(), -1) },
                      ].map((item) => (
                        <button
                          key={item.label}
                          type="button"
                          className={homeRestockForm.purchaseDate === item.date ? 'ingredients-choice-chip active' : 'ingredients-choice-chip'}
                          onClick={() =>
                            updateHomeRestockForm({
                              ...homeRestockForm,
                              purchaseDate: item.date,
                              expiryDate:
                                homeRestockForm.expiryInputMode === 'days'
                                  ? resolveExpiryDateFromDays(item.date, homeRestockForm.expiryDays)
                                  : homeRestockForm.expiryDate,
                            })
                          }
                        >
                          {item.label}
                        </button>
                      ))}
                    </div>
                    <label>
                      <span>购买日期</span>
                      <input
                        className="text-input"
                        type="date"
                        value={homeRestockForm.purchaseDate}
                        onChange={(event) =>
                          updateHomeRestockForm({
                            ...homeRestockForm,
                            purchaseDate: event.target.value,
                            expiryDate:
                              homeRestockForm.expiryInputMode === 'days'
                                ? resolveExpiryDateFromDays(event.target.value, homeRestockForm.expiryDays)
                                : homeRestockForm.expiryDate,
                          })
                        }
                      />
                    </label>
                  </section>

                  <section className="ingredients-restock-field-group">
                    <div className="ingredients-restock-field-head">
                      <span>存放位置</span>
                      <p className="subtle">按这次实际放的位置点一下。</p>
                    </div>
                    <div className="ingredients-restock-choice-row">
                      {['冷藏', '冷冻', '常温'].map((storage) => (
                        <button
                          key={storage}
                          type="button"
                          className={homeRestockForm.storageLocation === storage ? 'ingredients-choice-chip active' : 'ingredients-choice-chip'}
                          onClick={() =>
                            updateHomeRestockForm({
                              ...homeRestockForm,
                              storageLocation: storage,
                              status: resolveInventoryStatusForStorage(storage),
                            })
                          }
                        >
                          {storage}
                        </button>
                      ))}
                    </div>
                    <input
                      className="text-input"
                      placeholder="自定义位置"
                      value={homeRestockForm.storageLocation}
                      onChange={(event) =>
                        updateHomeRestockForm({
                          ...homeRestockForm,
                          storageLocation: event.target.value,
                          status: resolveInventoryStatusForStorage(event.target.value),
                        })
                      }
                    />
                  </section>

                  <section className="ingredients-restock-field-group">
                    <div className="ingredients-restock-field-head">
                      <span>到期信息</span>
                      <p className="subtle">确认这批食材怎么跟踪到期。</p>
                    </div>
                    <div className="ingredients-restock-choice-row">
                      {[
                        { value: 'none', label: '不记录' },
                        { value: 'days', label: '几天后到期' },
                        { value: 'manual_date', label: '包装到期日' },
                      ].map((item) => (
                        <button
                          key={item.value}
                          type="button"
                          className={homeRestockForm.expiryInputMode === item.value ? 'ingredients-choice-chip active' : 'ingredients-choice-chip'}
                          onClick={() => {
                            const nextMode = item.value as IngredientExpiryMode;
                            const nextDays = nextMode === 'days' ? homeRestockForm.expiryDays || '3' : '';
                            updateHomeRestockForm({
                              ...homeRestockForm,
                              expiryInputMode: nextMode,
                              expiryDays: nextDays,
                              expiryDate:
                                nextMode === 'days'
                                  ? resolveExpiryDateFromDays(homeRestockForm.purchaseDate, nextDays)
                                  : nextMode === 'manual_date'
                                    ? homeRestockForm.expiryDate
                                    : '',
                            });
                          }}
                        >
                          {item.label}
                        </button>
                      ))}
                    </div>
                    {homeRestockForm.expiryInputMode === 'days' && (
                      <div className="form-grid compact-grid">
                        <label>
                          <span>买后几天到期</span>
                          <input
                            className="text-input"
                            type="number"
                            min="1"
                            value={homeRestockForm.expiryDays}
                            onChange={(event) =>
                              updateHomeRestockForm({
                                ...homeRestockForm,
                                expiryDays: event.target.value,
                                expiryDate: resolveExpiryDateFromDays(homeRestockForm.purchaseDate, event.target.value),
                              })
                            }
                          />
                        </label>
                        <div className="ingredients-restock-result-card">
                          <span>预计到期日</span>
                          <strong>{homeRestockForm.expiryDate ? formatDate(homeRestockForm.expiryDate) : '先填天数'}</strong>
                          <p>{homeRestockForm.purchaseDate} 购入</p>
                        </div>
                      </div>
                    )}
                    {homeRestockForm.expiryInputMode === 'manual_date' && (
                      <label>
                        <span>包装到期日</span>
                        <input
                          className="text-input"
                          type="date"
                          value={homeRestockForm.expiryDate}
                          onChange={(event) => updateHomeRestockForm({ ...homeRestockForm, expiryDate: event.target.value })}
                        />
                      </label>
                    )}
                  </section>

                  <section className="ingredients-modal-advanced">
                    <div className="form-grid compact-grid ingredients-modal-advanced-fields">
                      <label>
                        <span>状态</span>
                        <select
                          className="text-input"
                          value={homeRestockForm.status}
                          onChange={(event) =>
                            updateHomeRestockForm({ ...homeRestockForm, status: event.target.value as InventoryStatus })
                          }
                        >
                          {Object.entries(INVENTORY_STATUS_LABELS).map(([key, label]) => (
                            <option key={key} value={key}>
                              {label}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label className="span-two">
                        <span>备注</span>
                        <textarea
                          className="text-input"
                          rows={3}
                          value={homeRestockForm.notes}
                          onChange={(event) => updateHomeRestockForm({ ...homeRestockForm, notes: event.target.value })}
                        />
                      </label>
                    </div>
                  </section>
                </div>

                <div className="ingredients-restock-footer-bar">
                  <div className="workspace-overlay-actions">
                    <ActionButton tone="secondary" type="button" onClick={closeHomeRestock} disabled={createInventoryMutation.isPending}>
                      取消
                    </ActionButton>
                    <ActionButton
                      tone="primary"
                      type="submit"
                      disabled={createInventoryMutation.isPending || !homeRestockForm.ingredientId}
                    >
                      {createInventoryMutation.isPending ? '保存中...' : '保存这批库存'}
                    </ActionButton>
                  </div>
                </div>
              </form>
            </WorkspaceModal>
          </div>
        )}

        {homeExpiredDisposalSummary && (
          <div className="workspace-overlay-root">
            <div className="workspace-overlay-backdrop" onClick={() => setHomeExpiredDisposalIngredientId(null)} />
            <WorkspaceModal
              title="销毁已过期批次"
              description="会将这些过期批次的剩余量清零，但保留批次历史记录和活动日志。"
              closeLabel="×"
              closeAriaLabel="关闭"
              className="workspace-modal-wide destroy-expired-modal"
              onClose={() => setHomeExpiredDisposalIngredientId(null)}
            >
              <form className="destroy-expired-form" onSubmit={(event) => void submitHomeExpiredDisposal(event)}>
              <div className="destroy-expired-scroll">
                <section className="ingredients-restock-identity-card destroy-expired-summary-card">
                  <div className="ingredients-restock-identity-media">
                    {homeExpiredDisposalSummary.ingredient.image?.url ? (
                      <img
                        src={resolveDashboardAssetUrl(homeExpiredDisposalSummary.ingredient.image.url)}
                        alt={homeExpiredDisposalSummary.ingredient.name}
                      />
                    ) : (
                      <span>{homeExpiredDisposalSummary.ingredient.name.slice(0, 1)}</span>
                    )}
                  </div>
                  <div className="ingredients-restock-identity-copy">
                    <div className="ingredients-restock-identity-head">
                      <div>
                        <h4>{homeExpiredDisposalSummary.ingredient.name}</h4>
                        <p>{homeExpiredDisposalSummary.ingredient.category || '未分类'} · {homeExpiredDisposalSummary.primaryStorage}</p>
                      </div>
                      <div className="destroy-expired-summary-badges">
                        <Badge>{homeExpiredDisposalItems.length} 条待销毁</Badge>
                        <Badge>{homeExpiredDisposalSummary.quantitySummaries[0]?.label ?? '当前已空'}</Badge>
                      </div>
                    </div>
                    <div className="destroy-expired-summary-grid">
                      <article className="destroy-expired-summary-metric is-primary">
                        <span>本次处理范围</span>
                        <strong>{homeExpiredDisposalItems.length} 条过期批次</strong>
                        <p>仅包含已经过期且当前仍有剩余量的批次。</p>
                      </article>
                      <article className="destroy-expired-summary-metric">
                        <span>处理结果</span>
                        <strong>清零剩余量</strong>
                        <p>批次记录、备注和活动日志都会继续保留。</p>
                      </article>
                    </div>
                  </div>
                </section>

                <section className="ingredients-restock-field-group destroy-expired-list-section">
                  <div className="ingredients-restock-field-head">
                    <span>将要销毁的批次</span>
                    <p className="subtle">只列出到期日早于今天的剩余批次；今天到期和未来到期不会出现在这里。</p>
                  </div>
                  {homeExpiredDisposalItems.length > 0 ? (
                    <div className="destroy-expired-list">
                      {homeExpiredDisposalItems.map((item) => {
                        const expiredDays = Math.abs(getExpiryDaysLeft(item.expiryDate, today));
                        return (
                          <article key={item.id} className="destroy-expired-item">
                            <div className="destroy-expired-item-head">
                              <div className="destroy-expired-item-title">
                                <strong>{item.remainingLabel}</strong>
                                <span>{item.storageLocation}</span>
                              </div>
                              <div className="destroy-expired-item-badges">
                                <Badge className="destroy-expired-item-badge is-danger">
                                  已过期 {expiredDays} 天
                                </Badge>
                                <Badge>{INVENTORY_STATUS_LABELS[item.status]}</Badge>
                              </div>
                            </div>
                            <div className="destroy-expired-item-meta">
                              <span>购买于 {formatDate(item.purchaseDate)}</span>
                              <span>到期日 {formatDate(item.expiryDate)}</span>
                            </div>
                            <p className="destroy-expired-item-note" title={item.notes || '当前没有备注'}>
                              {item.notes || '当前没有备注'}
                            </p>
                          </article>
                        );
                      })}
                    </div>
                  ) : (
                    <EmptyState
                      title="当前没有可销毁的批次"
                      description="这份食材现在没有“已过期且仍有剩余量”的批次，可以直接关闭这个面板。"
                    />
                  )}
                </section>
              </div>

              <div className="destroy-expired-footer-bar">
                <div className="destroy-expired-footer-summary">
                  <span>确认后将处理</span>
                  <strong>{homeExpiredDisposalItems.length} 条过期批次</strong>
                  <p>
                    {homeExpiredDisposalItems.length > 0
                      ? '系统会把这些批次的剩余量清零，并在刷新后同步库存状态。'
                      : '当前没有可销毁的过期批次。'}
                  </p>
                </div>
                <div className="workspace-overlay-actions">
                  <ActionButton
                    tone="secondary"
                    type="button"
                    onClick={() => setHomeExpiredDisposalIngredientId(null)}
                    disabled={disposeExpiredInventoryMutation.isPending}
                  >
                    取消
                  </ActionButton>
                  <ActionButton
                    tone="primary"
                    type="submit"
                    disabled={disposeExpiredInventoryMutation.isPending || homeExpiredDisposalItems.length === 0}
                  >
                    {disposeExpiredInventoryMutation.isPending ? '销毁中...' : '确认销毁'}
                  </ActionButton>
                </div>
              </div>
              </form>
            </WorkspaceModal>
          </div>
        )}
      </div>
      </div>
    </div>
  );
}

export default App;
