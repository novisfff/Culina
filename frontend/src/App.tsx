import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { API_BASE_URL, api } from './api/client';
import type {
  AiMode,
  ImageInputValue,
  Ingredient,
  FoodType,
  MealType,
  Recipe,
  RecipeDiscovery,
  RecipeScene,
  RecipeStats,
} from './api/types';
import { useAuth } from './auth/AuthContext';
import { IngredientWorkspace } from './components/ingredients/IngredientWorkspace';
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

type InviteFormState = {
  username: string;
  displayName: string;
  password: string;
  role: 'Owner' | 'Member';
  email: string;
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

function App() {
  const queryClient = useQueryClient();
  const { isAuthenticated, isLoading: authLoading, user, membership, logout } = useAuth();
  const [selectedRecipePlanDate, setSelectedRecipePlanDate] = useState(todayKey());
  const recipePlanWeekRange = useMemo(() => getRecipeWeekRange(selectedRecipePlanDate), [selectedRecipePlanDate]);
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
  const recipePlanQuery = useQuery({
    queryKey: ['recipe-plan', recipePlanWeekRange.start, recipePlanWeekRange.end],
    queryFn: () => api.getRecipePlan(recipePlanWeekRange.start, recipePlanWeekRange.end),
    enabled: isAuthenticated,
  });
  const recipeScenesQuery = useQuery({
    queryKey: ['recipe-scenes'],
    queryFn: api.getRecipeScenes,
    enabled: isAuthenticated,
  });
  const foodsQuery = useQuery({
    queryKey: ['foods'],
    queryFn: api.getFoods,
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
      void queryClient.invalidateQueries({ queryKey: ['activity-logs'] });
    },
  });
  const consumeInventoryMutation = useMutation({
    mutationFn: api.consumeInventory,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['inventory'] });
      void queryClient.invalidateQueries({ queryKey: ['activity-logs'] });
    },
  });
  const disposeExpiredInventoryMutation = useMutation({
    mutationFn: api.disposeExpiredInventory,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['inventory'] });
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
      void queryClient.invalidateQueries({ queryKey: ['recipe-plan'] });
      void queryClient.invalidateQueries({ queryKey: ['foods'] });
      void queryClient.invalidateQueries({ queryKey: ['activity-logs'] });
    },
  });
  const cookRecipeMutation = useMutation({
    mutationFn: ({ recipeId, payload }: { recipeId: string; payload: Parameters<typeof api.cookRecipe>[1] }) =>
      api.cookRecipe(recipeId, payload),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['inventory'] });
      void queryClient.invalidateQueries({ queryKey: ['recipe-discovery'] });
      void queryClient.invalidateQueries({ queryKey: ['recipe-stats'] });
      void queryClient.invalidateQueries({ queryKey: ['foods'] });
      void queryClient.invalidateQueries({ queryKey: ['meal-logs'] });
      void queryClient.invalidateQueries({ queryKey: ['recipe-plan'] });
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
  const createRecipePlanItemMutation = useMutation({
    mutationFn: api.createRecipePlanItem,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['recipe-plan'] });
      void queryClient.invalidateQueries({ queryKey: ['activity-logs'] });
    },
  });
  const updateRecipePlanItemMutation = useMutation({
    mutationFn: ({ itemId, payload }: { itemId: string; payload: Parameters<typeof api.updateRecipePlanItem>[1] }) =>
      api.updateRecipePlanItem(itemId, payload),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['recipe-plan'] });
      void queryClient.invalidateQueries({ queryKey: ['activity-logs'] });
    },
  });
  const deleteRecipePlanItemMutation = useMutation({
    mutationFn: api.deleteRecipePlanItem,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['recipe-plan'] });
      void queryClient.invalidateQueries({ queryKey: ['activity-logs'] });
    },
  });
  const createRecipeSceneMutation = useMutation({
    mutationFn: api.createRecipeScene,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['recipe-scenes'] });
      void queryClient.invalidateQueries({ queryKey: ['activity-logs'] });
    },
  });
  const updateRecipeSceneMutation = useMutation({
    mutationFn: ({ sceneId, payload }: { sceneId: string; payload: Parameters<typeof api.updateRecipeScene>[1] }) =>
      api.updateRecipeScene(sceneId, payload),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['recipe-scenes'] });
      void queryClient.invalidateQueries({ queryKey: ['activity-logs'] });
    },
  });
  const deleteRecipeSceneMutation = useMutation({
    mutationFn: api.deleteRecipeScene,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['recipe-scenes'] });
      void queryClient.invalidateQueries({ queryKey: ['activity-logs'] });
    },
  });
  const createFoodMutation = useMutation({
    mutationFn: api.createFood,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['foods'] });
      void queryClient.invalidateQueries({ queryKey: ['activity-logs'] });
    },
  });
  const toggleFavoriteMutation = useMutation({
    mutationFn: ({ foodId, favorite }: { foodId: string; favorite: boolean }) =>
      api.updateFoodFavorite(foodId, favorite),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['foods'] });
      void queryClient.invalidateQueries({ queryKey: ['activity-logs'] });
    },
  });
  const createMealMutation = useMutation({
    mutationFn: api.createMealLog,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['meal-logs'] });
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
  const recipePlanItems = recipePlanQuery.data ?? [];
  const recipeScenes: RecipeScene[] = recipeScenesQuery.data ?? [];
  const foods = foodsQuery.data ?? [];
  const mealLogs = mealLogsQuery.data ?? [];
  const activityLogs = activityLogsQuery.data ?? [];
  const aiConversations = aiConversationsQuery.data ?? [];
  const family = familyQuery.data;

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
    recipePlanQuery.isLoading ||
    recipeScenesQuery.isLoading ||
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
      food.flavor_tags.some((tag) => tag.includes(foodSearch));
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
        flavor_tags: splitTags(foodForm.flavorTags),
        source_name: foodForm.sourceName || (foodForm.type === 'selfMade' ? '家庭厨房' : ''),
        scene: foodForm.scene,
        notes: foodForm.notes,
        favorite: foodForm.favorite,
        recipe_id: foodForm.recipeId || undefined,
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

  function openFoodAi(foodId: string) {
    setAiMode('foodQa');
    setAiFoodId(foodId);
    setActiveTab('ai');
  }

  const headerName = currentUser?.display_name ?? '家庭成员';
  const latestActivity = activityLogs[0];
  const familyMotto = family?.motto ?? '今天吃得好，明天更有劲儿';
  const activeNavItem = NAV_ITEMS.find((item) => item.key === activeTab) ?? NAV_ITEMS[0];
  const shellHeaderClassName =
    activeTab === 'ingredients' || activeTab === 'recipes'
      ? 'card shell-header compact-shell-header shell-header-hide-on-large'
      : 'card shell-header compact-shell-header';
  const dashboardStats = [
    { label: '今日记录', value: `${familyStats.mealsToday} 顿` },
    { label: '库存提醒', value: `${inventoryAlerts.length} 条` },
    { label: '待买清单', value: `${pendingShoppingCount} 项` },
    { label: 'AI 建议', value: `${aiRecommendationCount} 条` },
  ];

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
          <header className={shellHeaderClassName}>
            <div className="shell-content-brand">
              <div className="inline-cluster">
                <p className="eyebrow">家庭工作台</p>
                {family?.location && <Badge>{family.location}</Badge>}
                <Badge className="shell-active-badge">
                  <span className="badge-inline-icon">
                    <ShellIcon name={activeNavItem.icon} />
                  </span>
                  {activeNavItem.label}
                </Badge>
              </div>
              <div className="shell-title-row">
                <strong>{family?.name ?? 'Culina 家庭厨房'}</strong>
                <p className="subtle">{familyMotto}</p>
              </div>
            </div>
            {latestActivity && (
              <div className="shell-status-line">
                <span className="eyebrow">最近动态</span>
                <p>
                  <strong>{latestActivity.actor_name ?? '家庭成员'}</strong> {latestActivity.summary}
                </p>
                <span className="subtle">{formatDateTime(latestActivity.created_at)}</span>
              </div>
            )}
            <div className="topbar-actions shell-mobile-actions">
              <div className="current-user-card topbar-user-card">
                <Avatar label={headerName} seed={currentUser?.avatar_seed ?? headerName} large />
                <div>
                  <strong>{headerName}</strong>
                  <p className="subtle">{membership?.role ?? 'Member'} · {currentUser?.username}</p>
                </div>
              </div>
              <button className="ghost-button topbar-logout" type="button" onClick={() => void logout()}>
                退出登录
              </button>
            </div>
          </header>

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
          <main className="page-stack">
            <section className="card dashboard-overview">
              <div className="dashboard-overview-copy">
                <p className="eyebrow">首页总览</p>
                <h2>今天的家庭厨房</h2>
                <p className="subtle">
                  今日已记录 {familyStats.mealsToday} 顿，库存提醒 {inventoryAlerts.length} 条，待买 {pendingShoppingCount} 项，
                  AI 建议 {aiRecommendationCount} 条。
                </p>
              </div>
              <div className="dashboard-overview-side">
                <div className="dashboard-overview-metrics">
                  {dashboardStats.map((item) => (
                    <div key={item.label} className="dashboard-metric-card">
                      <span>{item.label}</span>
                      <strong>{item.value}</strong>
                    </div>
                  ))}
                </div>
                <div className="hero-actions">
                  <button className="solid-button" type="button" onClick={() => setActiveTab('logs')}>
                    快速记一餐
                  </button>
                  <button className="ghost-button" type="button" onClick={() => setActiveTab('ingredients')}>
                    看库存提醒
                  </button>
                  <button className="ghost-button" type="button" onClick={() => setActiveTab('ai')}>
                    获取 AI 推荐
                  </button>
                </div>
              </div>
            </section>

            <div className="dashboard-grid">
              <div className="dashboard-main">
                <section className="card page-section">
                  <SectionHeading title="今日提醒" description="优先处理临期和低库存食材" />
                  <div className="stack-list">
                    {inventoryAlerts.length > 0 ? (
                      inventoryAlerts.map((alert) => (
                        <article key={alert.id} className={`alert-card ${alert.tone}`}>
                          <h3>{alert.title}</h3>
                          <p>{alert.detail}</p>
                        </article>
                      ))
                    ) : (
                      <EmptyState
                        title="今天没有库存预警"
                        description="库存状态稳定，可以直接安排今天的菜单。"
                      />
                    )}
                  </div>
                </section>

                <section className="card page-section">
                  <SectionHeading title="今日已吃" description="记录今天吃了什么，以及谁一起吃" />
                  <div className="stack-list">
                    {todaysMeals.length > 0 ? (
                      todaysMeals.map((meal) => (
                        <article key={meal.id} className="meal-card">
                          <div className="inline-between">
                            <div>
                              <h3>{MEAL_TYPE_LABELS[meal.meal_type]}</h3>
                              <p>{meal.food_entries.map((entry) => entry.food_name).join('、')}</p>
                            </div>
                            <Badge>{meal.mood}</Badge>
                          </div>
                          <p className="subtle">
                            参与成员：
                            {meal.participant_user_ids
                              .map((id) => members.find((member) => member.id === id)?.display_name)
                              .filter(Boolean)
                              .join('、')}
                          </p>
                          {meal.deduction_suggestions.length > 0 && (
                            <p className="subtle">
                              建议扣减：
                              {meal.deduction_suggestions
                                .map((item) => `${item.ingredient_name}${item.suggested_amount}${item.unit}`)
                                .join('、')}
                            </p>
                          )}
                        </article>
                      ))
                    ) : (
                      <EmptyState
                        title="今天还没有餐食记录"
                        description="从“快速记一餐”开始，先把今天这一餐记下来。"
                        action={
                          <button className="solid-button" type="button" onClick={() => setActiveTab('logs')}>
                            去记录
                          </button>
                        }
                      />
                    )}
                  </div>
                </section>
              </div>

              <div className="dashboard-side">
                <section className="card page-section">
                  <SectionHeading title="AI 推荐" description="基于库存、历史记录和家庭偏好生成建议" />
                  <div className="stack-list">
                    {(family?.ai_recommendations ?? []).length > 0 ? (
                      (family?.ai_recommendations ?? []).map((item) => (
                        <article key={item.id} className="recommendation-card">
                          <h3>{item.title}</h3>
                          <p>{item.detail}</p>
                        </article>
                      ))
                    ) : (
                      <EmptyState
                        title="还没有 AI 推荐"
                        description="去 AI 页面发起一次问答，首页会展示最新建议。"
                      />
                    )}
                  </div>
                </section>

                <section className="card page-section">
                  <SectionHeading title="家庭动态" description="最近是谁更新了厨房记录" />
                  <div className="stack-list">
                    {activityLogs.slice(0, 6).map((log) => (
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
              </div>
            </div>
          </main>
        )}

        {activeTab === 'foods' &&
          (foodWorkspaceView === 'create' ? (
            <main className="page-stack">
              <WorkspaceSubpageShell className="workspace-editor-subpage">
                <WorkspaceSubpageHeader
                  eyebrow="食物"
                  title="新增食物"
                  description="把基础信息、图片和补充说明集中录入，保存后再回到食物库继续浏览。"
                  backLabel="返回食物库"
                  onBack={() => setFoodWorkspaceView('list')}
                  meta={<Badge>食物子页</Badge>}
                  variant="compact"
                />
                <form className="page-columns page-columns-wide workspace-editor-layout" onSubmit={submitFood}>
                  <div className="page-main-column workspace-editor-main">
                    <section className="form-panel-section">
                      <div className="section-mini-title">基础信息</div>
                      <div className="form-grid nested-grid">
                        <label>
                          <span>食物名称</span>
                          <input
                            className="text-input"
                            value={foodForm.name}
                            onChange={(event) => setFoodForm({ ...foodForm, name: event.target.value })}
                          />
                        </label>
                        <label>
                          <span>类型</span>
                          <select
                            className="text-input"
                            value={foodForm.type}
                            onChange={(event) =>
                              setFoodForm({ ...foodForm, type: event.target.value as FoodType })
                            }
                          >
                            {Object.entries(FOOD_TYPE_LABELS).map(([key, label]) => (
                              <option key={key} value={key}>
                                {label}
                              </option>
                            ))}
                          </select>
                        </label>
                        <label>
                          <span>分类</span>
                          <input
                            className="text-input"
                            value={foodForm.category}
                            onChange={(event) => setFoodForm({ ...foodForm, category: event.target.value })}
                          />
                        </label>
                        <label>
                          <span>来源信息</span>
                          <input
                            className="text-input"
                            value={foodForm.sourceName}
                            onChange={(event) => setFoodForm({ ...foodForm, sourceName: event.target.value })}
                          />
                        </label>
                      </div>
                    </section>

                    <ImageComposer
                      title="食物图片"
                      value={foodForm.images}
                      previewLabel={foodForm.name || '食物'}
                      onUpload={(files) =>
                        void handleImageUpload(files, foodImagePayload, (next) => setFoodForm({ ...foodForm, images: next }), setFoodImageState)
                      }
                      onGenerate={(mode) =>
                        void handleGenerateImage(mode, foodForm.images, foodImagePayload, (next) => setFoodForm({ ...foodForm, images: next }), setFoodImageState)
                      }
                      onReset={() =>
                        resetImageInput((value) => setFoodForm({ ...foodForm, images: value }), setFoodImageState)
                      }
                      isGenerating={foodImageState.isGenerating}
                      errorMessage={foodImageState.errorMessage}
                      variant="workspace-inline"
                    />

                    <section className="form-panel-section">
                      <div className="section-mini-title">补充说明</div>
                      <div className="form-grid nested-grid">
                        <label>
                          <span>就餐场景</span>
                          <input
                            className="text-input"
                            value={foodForm.scene}
                            onChange={(event) => setFoodForm({ ...foodForm, scene: event.target.value })}
                          />
                        </label>
                        <label>
                          <span>口味标签</span>
                          <input
                            className="text-input"
                            value={foodForm.flavorTags}
                            onChange={(event) => setFoodForm({ ...foodForm, flavorTags: event.target.value })}
                          />
                        </label>
                        {foodForm.type === 'selfMade' && (
                          <label className="span-two">
                            <span>关联菜谱</span>
                            <select
                              className="text-input"
                              value={foodForm.recipeId}
                              onChange={(event) => setFoodForm({ ...foodForm, recipeId: event.target.value })}
                            >
                              <option value="">请选择已创建菜谱</option>
                              {recipes.map((recipe) => (
                                <option key={recipe.id} value={recipe.id}>
                                  {recipe.title}
                                </option>
                              ))}
                            </select>
                          </label>
                        )}
                        <label className="span-two">
                          <span>备注</span>
                          <textarea
                            className="text-input"
                            rows={3}
                            value={foodForm.notes}
                            onChange={(event) => setFoodForm({ ...foodForm, notes: event.target.value })}
                          />
                        </label>
                        <label className="checkbox-row span-two checkbox-card">
                          <input
                            type="checkbox"
                            checked={foodForm.favorite}
                            onChange={(event) =>
                              setFoodForm({ ...foodForm, favorite: event.target.checked })
                            }
                          />
                          <span>保存时同时加入收藏</span>
                        </label>
                      </div>
                    </section>
                  </div>

                  <aside className="page-side-column workspace-editor-side">
                    <section className="form-panel-section workspace-action-rail sticky-panel">
                      <div className="workspace-action-rail-copy">
                        <p className="eyebrow">当前录入</p>
                        <h3>准备保存这份食物</h3>
                        <p className="subtle">主图、类型和关联菜谱都会在保存时一起写入资料库。</p>
                      </div>
                      <div className="workspace-summary-list">
                        {foodSummaryItems.map((item) => (
                          <div key={item.label} className="workspace-summary-row">
                            <span>{item.label}</span>
                            <strong title={item.value}>{item.value}</strong>
                          </div>
                        ))}
                        {!foodValidIngredientBinding && (
                          <div className="workspace-inline-note">
                            自做菜需要先关联一个已创建菜谱。
                          </div>
                        )}
                      </div>
                      <div className="workspace-rail-actions">
                        <ActionButton tone="primary" type="submit" disabled={foodSubmitDisabled}>
                          {createFoodMutation.isPending ? '保存中...' : foodImageState.isGenerating ? '生成主图中...' : '保存食物'}
                        </ActionButton>
                        <ActionButton tone="secondary" type="button" onClick={() => setFoodWorkspaceView('list')}>
                          返回食物库
                        </ActionButton>
                      </div>
                    </section>
                  </aside>
                </form>
              </WorkspaceSubpageShell>
            </main>
          ) : (
            <main className="page-stack">
              <PageHeader
                variant="compact"
                eyebrow="食物"
                title="管理家庭常吃的食物"
                description={`已收录 ${foods.length} 份食物，最近共有 ${recentMeals.length} 条餐食记录。`}
                actions={
                  <div className="hero-actions">
                    <ActionButton tone="primary" type="button" onClick={() => setFoodWorkspaceView('create')}>
                      新增食物
                    </ActionButton>
                    <ActionButton tone="secondary" type="button" onClick={() => setActiveTab('logs')}>
                      去记一餐
                    </ActionButton>
                  </div>
                }
              />
              <section className="card page-section">
                <WorkspaceToolbar
                  actions={<p className="workspace-toolbar-summary">显示 {filteredFoods.length} / {foods.length} 份食物</p>}
                >
                  <div className="workspace-toolbar-stack">
                    <div className="workspace-toolbar-copy">
                      <h3>食物库</h3>
                      <p className="subtle">按类型、分类和口味快速浏览常吃内容。</p>
                    </div>
                    <div className="toolbar toolbar-inline">
                      <input
                        className="text-input"
                        placeholder="搜索食物、分类或口味"
                        value={foodSearch}
                        onChange={(event) => setFoodSearch(event.target.value)}
                      />
                      <SegmentedTabs
                        options={[
                          { value: 'all', label: '全部' },
                          ...Object.entries(FOOD_TYPE_LABELS).map(([key, label]) => ({
                            value: key as 'all' | FoodType,
                            label,
                          })),
                        ]}
                        value={foodTypeFilter}
                        onChange={(value) => setFoodTypeFilter(value)}
                      />
                    </div>
                  </div>
                </WorkspaceToolbar>
                {filteredFoods.length > 0 ? (
                  <div className="food-grid">
                    {filteredFoods.map((food) => (
                      <article key={food.id} className="food-card">
                        {getFoodCover(food, recipes) ? (
                          <img
                            className="cover-image"
                            src={`${API_BASE_URL}${getFoodCover(food, recipes)}`}
                            alt={food.name}
                          />
                        ) : (
                          <div className="cover-placeholder">{food.name}</div>
                        )}
                        <div className="food-card-body">
                          <div className="inline-between">
                            <h3>{food.name}</h3>
                            <button
                              className={food.favorite ? 'chip active' : 'chip'}
                              type="button"
                              onClick={() =>
                                void toggleFavoriteMutation.mutateAsync({
                                  foodId: food.id,
                                  favorite: !food.favorite,
                                })
                              }
                            >
                              {food.favorite ? '已收藏' : '收藏'}
                            </button>
                          </div>
                          <p className="subtle">
                            {FOOD_TYPE_LABELS[food.type]} · {food.category} · 最近出现 {countRecentMealUsage(food.id)} 次
                          </p>
                          <p>{food.notes || food.source_name || '等待补充更多描述'}</p>
                          <div className="tag-row">
                            {food.flavor_tags.map((tag) => (
                              <Badge key={tag}>{tag}</Badge>
                            ))}
                          </div>
                          <div className="inline-actions">
                            <ActionButton tone="secondary" size="compact" type="button" onClick={() => openFoodAi(food.id)}>
                              问 AI
                            </ActionButton>
                            {food.recipe_id && <Badge>已绑定菜谱</Badge>}
                          </div>
                        </div>
                      </article>
                    ))}
                  </div>
                ) : (
                  <EmptyState
                    title="没有匹配的食物"
                    description="换个搜索词试试，或者直接新建一份常吃食物。"
                    action={
                      <ActionButton tone="primary" type="button" onClick={() => setFoodWorkspaceView('create')}>
                        新增食物
                      </ActionButton>
                    }
                  />
                )}
              </section>
            </main>
          ))}

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
              recipePlanItems={recipePlanItems}
              recipeScenes={recipeScenes}
              recipePlanWeekRange={recipePlanWeekRange}
              onRecipePlanPreviousWeek={() => setSelectedRecipePlanDate(addDateKeyDays(recipePlanWeekRange.start, -7))}
              onRecipePlanCurrentWeek={() => setSelectedRecipePlanDate(todayKey())}
              onRecipePlanNextWeek={() => setSelectedRecipePlanDate(addDateKeyDays(recipePlanWeekRange.end, 1))}
              createRecipe={(payload) => createRecipeMutation.mutateAsync(payload)}
              updateRecipe={(recipeId, payload) => updateRecipeMutation.mutateAsync({ recipeId, payload })}
              deleteRecipe={(recipeId) => deleteRecipeMutation.mutateAsync(recipeId)}
              cookRecipe={(recipeId, payload) => cookRecipeMutation.mutateAsync({ recipeId, payload })}
              previewCookRecipe={(recipeId, payload) => previewCookRecipeMutation.mutateAsync({ recipeId, payload })}
              generateRecipeDraft={(payload) => api.generateRecipeDraft(payload)}
              createShoppingItem={(payload) => createShoppingMutation.mutateAsync(payload)}
              addRecipeFavorite={(recipeId) => addRecipeFavoriteMutation.mutateAsync(recipeId)}
              removeRecipeFavorite={(recipeId) => removeRecipeFavoriteMutation.mutateAsync(recipeId)}
              createRecipePlanItem={(payload) => createRecipePlanItemMutation.mutateAsync(payload)}
              updateRecipePlanItem={(itemId, payload) => updateRecipePlanItemMutation.mutateAsync({ itemId, payload })}
              deleteRecipePlanItem={(itemId) => deleteRecipePlanItemMutation.mutateAsync(itemId)}
              createRecipeScene={(payload) => createRecipeSceneMutation.mutateAsync(payload)}
              updateRecipeScene={(sceneId, payload) => updateRecipeSceneMutation.mutateAsync({ sceneId, payload })}
              deleteRecipeScene={(sceneId) => deleteRecipeSceneMutation.mutateAsync(sceneId)}
              isCreatingRecipe={createRecipeMutation.isPending}
              isUpdatingRecipe={updateRecipeMutation.isPending}
              isDeletingRecipe={deleteRecipeMutation.isPending}
              isCookingRecipe={cookRecipeMutation.isPending}
              isCreatingShopping={createShoppingMutation.isPending}
              isUpdatingFavorite={addRecipeFavoriteMutation.isPending || removeRecipeFavoriteMutation.isPending}
              isUpdatingPlan={
                createRecipePlanItemMutation.isPending ||
                updateRecipePlanItemMutation.isPending ||
                deleteRecipePlanItemMutation.isPending
              }
              isUpdatingScene={
                createRecipeSceneMutation.isPending ||
                updateRecipeSceneMutation.isPending ||
                deleteRecipeSceneMutation.isPending
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
      </div>
      </div>
    </div>
  );
}

export default App;
