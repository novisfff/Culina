import type {
  AiGeneratedRecipeDraft,
  CookRecipeRequest,
  Difficulty,
  ImageInputValue,
  Ingredient,
  MealType,
  Recipe,
  RecipeIngredient,
  RecipePayload,
  RecipeScene,
  RecipeStep,
} from '../../api/types';
import { resolveAssetUrl } from '../../lib/assets';
import { readJsonStorage, removeStorage, writeJsonStorage } from '../../lib/storage';
import type { AiRenderPayload } from '../../lib/aiImages';
import { buildIngredientPlaceholderSvg, emptyImages, splitTags, todayKey } from '../../lib/ui';
import { MEAL_TYPE_OPTIONS, OPTIONAL_INGREDIENT_NOTE_PATTERN } from './RecipeWorkspaceOptions';
import type { RecipeCardViewModel } from './workspaceModel';

export type RecipeDraftIngredient = Omit<RecipeIngredient, 'quantity'> & { quantity: number | string };

export type RecipeStepDraft = {
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
  difficulty: Difficulty | '';
  steps: RecipeStepDraft[];
  tips: string;
  sceneTags: string;
  images: ImageInputValue;
  autoCreateFood: boolean;
};

export type ManagedRecipeScene = {
  id?: string;
  name: string;
  description: string;
  imagePrompt: string;
  imageAssetId?: string;
  imageAssetUrl?: string;
  hidden?: boolean;
  custom?: boolean;
};

export type RecipeSceneCard = {
  name: string;
  count: number;
  description?: string;
  imagePrompt?: string;
  imageAssetId?: string;
  imageAssetUrl?: string;
  custom?: boolean;
};

export type RecipeDraftGenerationStage = 'idle' | 'drafting' | 'imaging' | 'done' | 'error';

export type RecipeDraftAiFormState = {
  prompt: string;
};

export type RecipeSceneFormMode = 'create' | 'edit' | null;
export type RecipeShoppingDraftSource = 'shortage' | 'existing' | 'custom';
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

export type RecipeShoppingCustomForm = {
  title: string;
  quantity: string;
  unit: string;
};

export type RecipeNotice = {
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

export type RecipeShoppingIngredientOption = {
  id: string;
  name: string;
  unit: string;
  imageUrl: string;
  category: string;
};

export function newDraftId(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function createEmptyRecipeStepDraft(id = newDraftId('step')): RecipeStepDraft {
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

export function defaultRecipeForm(): RecipeFormState {
  return {
    title: '',
    servings: '2',
    prepMinutes: '',
    difficulty: '',
    steps: [createEmptyRecipeStepDraft('step-1')],
    tips: '',
    sceneTags: '',
    images: emptyImages(),
    autoCreateFood: true,
  };
}

export function defaultIngredientRows(): RecipeDraftIngredient[] {
  return [{ id: 'draft-1', ingredient_name: '', ingredient_id: '', quantity: '', unit: '个', note: '' }];
}

export function defaultRecipeDraftAiForm(): RecipeDraftAiFormState {
  return {
    prompt: '',
  };
}

export function getRecipeDraftGenerationButtonLabel(stage: RecipeDraftGenerationStage) {
  switch (stage) {
    case 'drafting':
      return '正在生成菜谱';
    case 'imaging':
      return '正在生成封面';
    case 'done':
      return '已填入表单';
    case 'error':
      return '重新生成';
    default:
      return 'AI 补全菜谱';
  }
}

export function getRecipeDraftGenerationActionLabel(stage: RecipeDraftGenerationStage) {
  switch (stage) {
    case 'drafting':
      return '正在生成菜谱';
    case 'imaging':
      return '正在生成封面';
    case 'done':
      return '已填入表单';
    case 'error':
      return '重试生成';
    default:
      return '确定并填入';
  }
}

export function getRecipeDraftGenerationStatusCopy(stage: RecipeDraftGenerationStage) {
  switch (stage) {
    case 'drafting':
      return {
        title: '正在生成菜谱结构',
        description: '会补全原料、步骤、技巧和标签。',
      };
    case 'imaging':
      return {
        title: '菜谱已生成，正在生成封面',
        description: '图片失败不会影响文本草稿。',
      };
    case 'done':
      return {
        title: '已填入表单',
        description: '可以继续调整后保存。',
      };
    case 'error':
      return {
        title: '生成失败',
        description: '可以修改说明后重试。',
      };
    default:
      return {
        title: '',
        description: '',
      };
  }
}

export function getRecipeDraftGenerationStepState(stage: RecipeDraftGenerationStage, index: number) {
  const activeIndexByStage: Record<RecipeDraftGenerationStage, number> = {
    idle: -1,
    drafting: 1,
    imaging: 2,
    done: 3,
    error: 1,
  };
  const activeIndex = activeIndexByStage[stage];
  if (stage === 'done') return 'completed';
  if (stage === 'error' && index === activeIndex) return 'error';
  if (index < activeIndex) return 'completed';
  if (index === activeIndex) return 'active';
  return 'pending';
}

export function buildFormFromRecipe(recipe: Recipe): { form: RecipeFormState; ingredients: RecipeDraftIngredient[] } {
  return {
    form: {
      title: recipe.title,
      servings: String(recipe.servings),
      prepMinutes: String(recipe.prep_minutes),
      difficulty: recipe.difficulty,
      steps: recipe.steps.length > 0 ? recipe.steps.map(buildRecipeStepDraft) : [createEmptyRecipeStepDraft('step-1')],
      tips: recipe.tips,
      sceneTags: '',
      images: recipe.images[0] ? { generatedAsset: recipe.images[0] } : emptyImages(),
      autoCreateFood: false,
    },
    ingredients:
      recipe.ingredient_items.length > 0
        ? recipe.ingredient_items.map((item) => ({ ...item }))
        : defaultIngredientRows(),
  };
}

export function mapRecipeScene(scene: RecipeScene): ManagedRecipeScene {
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

export function defaultSceneDraft(): ManagedRecipeScene {
  return { name: '', description: '', imagePrompt: '', custom: true };
}

export function resolveIngredientImageUrl(ingredient: Ingredient | null | undefined, fallbackName: string) {
  return resolveAssetUrl(ingredient?.image?.url) ?? buildIngredientPlaceholderSvg(fallbackName || ingredient?.name || '食材');
}

export function resolveErrorMessage(reason: unknown, fallback: string) {
  return reason instanceof Error && reason.message.trim() ? reason.message : fallback;
}

function getRecipeMediaIds(images: ImageInputValue) {
  return images.generatedAsset ? [images.generatedAsset.id] : [];
}

function parsePositiveNumber(value: number | string, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function resolveRecipeDifficulty(value: RecipeFormState['difficulty']): Difficulty {
  return value || 'easy';
}

export type RecipeUiIconName =
  | 'basket'
  | 'bell'
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
  | 'logo'
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

export function buildRecipePayload(form: RecipeFormState, rows: RecipeDraftIngredient[], ingredients: Ingredient[]): RecipePayload {
  return {
    title: form.title.trim(),
    servings: Number(form.servings),
    prep_minutes: parsePositiveNumber(form.prepMinutes, 20),
    difficulty: resolveRecipeDifficulty(form.difficulty),
    ingredient_items: rows
      .filter((item) => item.ingredient_id || item.ingredient_name.trim())
      .map((item) => {
        const ingredient = ingredients.find((entry) => entry.id === item.ingredient_id);
        return {
          ingredient_id: item.ingredient_id || null,
          ingredient_name: ingredient?.name ?? item.ingredient_name.trim(),
          quantity: parsePositiveNumber(item.quantity, 1),
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

export function formatCookQuantity(value: number) {
  return Number(value.toFixed(2)).toString().replace(/\.0+$/, '');
}

export function formatShoppingQuantity(value: number) {
  return Number(value.toFixed(2)).toString().replace(/\.0+$/, '');
}

export function formatCookTimer(seconds: number) {
  const safeSeconds = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(safeSeconds / 60);
  const restSeconds = safeSeconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(restSeconds).padStart(2, '0')}`;
}

export function getStepSuggestedSeconds(step: Pick<RecipeStep, 'estimated_minutes'> | null | undefined) {
  return step?.estimated_minutes && step.estimated_minutes > 0 ? Math.round(step.estimated_minutes * 60) : null;
}

export function formatCookTimerDuration(seconds: number | null | undefined) {
  if (!seconds || seconds <= 0) return '未设置';
  const minutes = Math.floor(seconds / 60);
  const restSeconds = seconds % 60;
  if (minutes <= 0) return `${restSeconds}秒`;
  return restSeconds ? `${minutes}分${String(restSeconds).padStart(2, '0')}秒` : `${minutes}分钟`;
}

export function getRecipeStepTitle(step: Partial<Pick<RecipeStep, 'title'>>, index: number) {
  return step.title?.trim() || `步骤 ${index + 1}`;
}

export function getRecipeStepSummary(step: Partial<Pick<RecipeStep, 'summary' | 'text'>>) {
  return step.summary?.trim() || step.text?.trim() || '';
}

export function getRecipeStepIconName(icon: string | undefined): RecipeUiIconName {
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

export function clampStepIndex(index: number, stepCount: number) {
  return Math.min(Math.max(index, 0), Math.max(stepCount - 1, 0));
}

type RecipeCookSessionSource = 'direct' | 'plan';

type PersistedRecipeCookSession = {
  version: 2;
  savedAt: string;
  source: RecipeCookSessionSource;
  planItemId: string | null;
  session: RecipeCookSessionState;
};

const DIRECT_COOK_SESSION_RETENTION_MS = 24 * 60 * 60 * 1000;
const PLAN_COOK_SESSION_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export function recipeCookSessionKey(recipeId: string, planItemId: string | null = null) {
  return planItemId ? `culina-recipe-cook-session:${recipeId}:plan:${planItemId}` : `culina-recipe-cook-session:${recipeId}:direct`;
}

function legacyRecipeCookSessionKey(recipeId: string) {
  return `culina-recipe-cook-session:${recipeId}`;
}

function getCookSessionSource(planItemId: string | null): RecipeCookSessionSource {
  return planItemId ? 'plan' : 'direct';
}

export function buildDefaultCookSession(recipe: Pick<Recipe, 'servings'>, planItemId: string | null = null): RecipeCookSessionState {
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

function parsePersistedCookSession(value: unknown): PersistedRecipeCookSession | null {
  if (!value || typeof value !== 'object') return null;
  const parsed = value as Partial<PersistedRecipeCookSession>;
  if (parsed.version !== 2) return null;
  if (typeof parsed.savedAt !== 'string' || !parsed.savedAt) return null;
  if (parsed.source !== 'direct' && parsed.source !== 'plan') return null;
  if (parsed.planItemId !== null && typeof parsed.planItemId !== 'string') return null;
  if (!parsed.session || typeof parsed.session !== 'object') return null;
  return parsed as PersistedRecipeCookSession;
}

function isCookSessionExpired(savedAt: string, source: RecipeCookSessionSource, now: number) {
  const savedAtMs = Date.parse(savedAt);
  if (!Number.isFinite(savedAtMs)) return true;
  const age = now - savedAtMs;
  if (age < 0) return false;
  const retentionMs = source === 'plan' ? PLAN_COOK_SESSION_RETENTION_MS : DIRECT_COOK_SESSION_RETENTION_MS;
  return age > retentionMs;
}

export function loadCookSession(recipe: Pick<Recipe, 'id' | 'servings' | 'steps'>, planItemId: string | null = null, now: number = Date.now()) {
  const source = getCookSessionSource(planItemId);
  const key = recipeCookSessionKey(recipe.id, planItemId);
  removeStorage(legacyRecipeCookSessionKey(recipe.id));
  const persisted = parsePersistedCookSession(readJsonStorage<unknown>(key, null));
  if (
    !persisted ||
    persisted.source !== source ||
    persisted.planItemId !== planItemId ||
    isCookSessionExpired(persisted.savedAt, persisted.source, now)
  ) {
    removeStorage(key);
    return { session: buildDefaultCookSession(recipe, planItemId), restored: false };
  }
  const session = sanitizeCookSession({ ...persisted.session, planItemId }, recipe, planItemId);
  return { session, restored: true };
}

export function saveCookSession(recipeId: string, session: RecipeCookSessionState) {
  const source = getCookSessionSource(session.planItemId);
  const persisted: PersistedRecipeCookSession = {
    version: 2,
    savedAt: new Date().toISOString(),
    source,
    planItemId: session.planItemId,
    session: { ...session, timerRunning: false },
  };
  writeJsonStorage(recipeCookSessionKey(recipeId, session.planItemId), persisted);
}

export function clearCookSession(recipeId: string, planItemId: string | null = null) {
  removeStorage(recipeCookSessionKey(recipeId, planItemId));
  removeStorage(legacyRecipeCookSessionKey(recipeId));
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
    food_plan_item_id: args.planItemId ?? undefined,
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

export function stripRecipeIngredientRequirementNote(note: string) {
  return note.trim().replace(OPTIONAL_INGREDIENT_NOTE_PATTERN, '').trim();
}

export function applyRecipeIngredientRequirement(note: string, requirement: RecipeShoppingRequirement) {
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

export function buildRecipeIngredientAvailabilityMap(card: RecipeCardViewModel) {
  return new Map(card.ingredientAvailability.map((item) => [item.item.id, item]));
}

export function buildShoppingDraftSourceLabel(source: RecipeShoppingDraftSource) {
  return source === 'shortage' ? '缺料' : source === 'existing' ? '已有食材' : '自定义';
}

export function buildShoppingRequirementLabel(requirement: RecipeShoppingRequirement) {
  return requirement === 'optional' ? '可选' : '必须';
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isAiRecipeDraftIngredient(value: unknown): value is AiGeneratedRecipeDraft['ingredient_items'][number] {
  if (!value || typeof value !== 'object') return false;
  const item = value as Partial<AiGeneratedRecipeDraft['ingredient_items'][number]>;
  return (
    (typeof item.ingredient_id === 'string' || item.ingredient_id === null || item.ingredient_id === undefined) &&
    typeof item.ingredient_name === 'string' &&
    typeof item.quantity === 'number' &&
    Number.isFinite(item.quantity) &&
    typeof item.unit === 'string' &&
    typeof item.note === 'string'
  );
}

function isAiRecipeDraftStep(value: unknown): value is AiGeneratedRecipeDraft['steps'][number] {
  if (!value || typeof value !== 'object') return false;
  const step = value as Partial<AiGeneratedRecipeDraft['steps'][number]>;
  return (
    typeof step.title === 'string' &&
    typeof step.text === 'string' &&
    (typeof step.icon === 'string' || step.icon === undefined) &&
    (typeof step.summary === 'string' || step.summary === undefined) &&
    (typeof step.estimated_minutes === 'number' || step.estimated_minutes === null || step.estimated_minutes === undefined) &&
    (typeof step.tip === 'string' || step.tip === undefined) &&
    (isStringArray(step.key_points) || step.key_points === undefined)
  );
}

export function isAiGeneratedRecipeDraft(value: unknown): value is AiGeneratedRecipeDraft {
  if (!value || typeof value !== 'object') return false;
  const draft = value as Partial<AiGeneratedRecipeDraft>;
  return (
    typeof draft.title === 'string' &&
    typeof draft.servings === 'number' &&
    typeof draft.prep_minutes === 'number' &&
    typeof draft.difficulty === 'string' &&
    Array.isArray(draft.ingredient_items) &&
    draft.ingredient_items.every(isAiRecipeDraftIngredient) &&
    Array.isArray(draft.steps) &&
    draft.steps.every(isAiRecipeDraftStep) &&
    typeof draft.tips === 'string' &&
    isStringArray(draft.scene_tags)
  );
}

export function buildRecipeFormFromGeneratedDraft(
  draft: AiGeneratedRecipeDraft,
  currentForm: RecipeFormState = defaultRecipeForm()
): { form: RecipeFormState; ingredients: RecipeDraftIngredient[] } {
  return {
    form: {
      ...currentForm,
      title: draft.title,
      servings: String(draft.servings || 2),
      prepMinutes: String(draft.prep_minutes || 20),
      difficulty: draft.difficulty || 'easy',
      steps:
        draft.steps.length > 0
          ? draft.steps.map((step) => ({
              id: newDraftId('step'),
              title: step.title || '',
              text: step.text || '',
              icon: step.icon || 'pan',
              summary: step.summary || '',
              estimatedMinutes: step.estimated_minutes ? String(step.estimated_minutes) : '',
              tip: step.tip || '',
              keyPoints: (step.key_points ?? []).join('\n'),
            }))
          : currentForm.steps,
      tips: draft.tips,
      sceneTags: (draft.scene_tags ?? []).join('、'),
    },
    ingredients:
      draft.ingredient_items.length > 0
        ? draft.ingredient_items.map((item) => ({
            id: newDraftId('ingredient'),
            ingredient_id: item.ingredient_id ?? '',
            ingredient_name: item.ingredient_name,
            quantity: item.quantity,
            unit: item.unit,
            note: item.note,
          }))
        : defaultIngredientRows(),
  };
}

export function hasRecipeDraftMinimumInput(form: RecipeFormState, rows: RecipeDraftIngredient[], prompt: string) {
  return (
    Boolean(form.title.trim()) ||
    Boolean(prompt.trim()) ||
    rows.some((item) => Boolean(item.ingredient_id || item.ingredient_name.trim()))
  );
}

export function mapRecipeIdsToCards(recipeIds: string[] | undefined, cardByRecipeId: Map<string, RecipeCardViewModel>) {
  return (recipeIds ?? [])
    .map((recipeId) => cardByRecipeId.get(recipeId))
    .filter((card): card is RecipeCardViewModel => Boolean(card));
}

export function buildRecipeImagePayload(form: RecipeFormState, rows: RecipeDraftIngredient[], ingredients: Ingredient[]): AiRenderPayload {
  return {
    entity_type: 'recipe',
    title: form.title.trim() || '家庭菜谱',
    size: '1792*1008',
    notes: [
      form.tips.trim(),
      '画面必须呈现这份菜谱做完后的成菜状态，主菜清晰自然，周围有真实餐桌、浅色餐具或少量相关食材，不能出现大片空白。',
      '构图保持自然均衡，主体不要压到边缘，画面中要有可看的食物或厨房环境细节。',
      '保持家庭厨房静物摄影风格，浅色、通透、温暖，避免僵硬居中构图和商业广告摆拍。',
    ]
      .filter(Boolean)
      .join('\n'),
    tags: [],
    scene: '家庭日常',
    ingredient_names: rows
      .map((item) => {
        const matched = ingredients.find((ingredient) => ingredient.id === item.ingredient_id);
        return matched?.name ?? item.ingredient_name.trim();
      })
      .filter(Boolean),
  };
}

export function buildSceneImagePayload(scene: Pick<ManagedRecipeScene, 'name' | 'description' | 'imagePrompt'>): AiRenderPayload {
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
