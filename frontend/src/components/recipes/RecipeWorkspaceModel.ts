import type {
  AiGeneratedRecipeDraft,
  CookRecipePreviewItem,
  CookRecipeRequest,
  CookRecipeResponse,
  CookRecipeShortage,
  Difficulty,
  ImageInputValue,
  Ingredient,
  IngredientQuantityTrackingMode,
  MealType,
  Recipe,
  RecipeIngredient,
  RecipePayload,
  RecipeScene,
  RecipeStep,
} from '../../api/types';
import { resolveAssetUrl } from '../../lib/assets';
import { tracksIngredientQuantity } from '../../lib/ingredientTracking';
import { readJsonStorage, removeStorage, writeJsonStorage } from '../../lib/storage';
import type { AiRenderPayload } from '../../lib/aiImages';
import { buildIngredientPlaceholderSvg, emptyImages, splitTags, todayKey } from '../../lib/ui';
import { MEAL_TYPE_OPTIONS, OPTIONAL_INGREDIENT_NOTE_PATTERN } from './RecipeWorkspaceOptions';
import type { RecipeCardViewModel } from './workspaceModel';

export type RecipeDraftIngredient = Omit<RecipeIngredient, 'quantity'> & {
  quantity: number | string;
  quantity_tracking_mode?: IngredientQuantityTrackingMode;
};

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
  pendingImageJobId?: string | null;
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
  ingredientId?: string | null;
  title: string;
  quantity: string;
  unit: string;
  quantityMode?: 'track_quantity' | 'not_track_quantity';
  displayLabel?: string | null;
  reason: string;
  source: RecipeShoppingDraftSource;
  requirement: RecipeShoppingRequirement;
  recipeIngredientId?: string;
};

export type RecipeShoppingPayload = {
  title: string;
  quantity: number | null;
  unit: string | null;
  ingredient_id: string;
  quantity_mode: 'track_quantity' | 'not_track_quantity';
  display_label: string | null;
  reason: string;
};

export type RecipeShoppingCustomForm = {
  ingredientId: string | null;
  title: string;
  quantity: string;
  unit: string;
};

export type RecipeNotice = {
  tone: 'success' | 'warning' | 'danger';
  title: string;
  message: string;
};

export type CookTimerState = {
  id: string;
  name: string;
  seconds: number;
  running: boolean;
  lastTickedAt: number | null;
  mode: 'countup' | 'countdown';
  durationSeconds: number | null;
  source: 'step' | 'manual';
  stepId: string | null;
};

export type RecipeCookAssistantMessagePart =
  | { id: string; type: 'text'; text: string }
  | { id: string; type: 'tool_card'; label?: string; detail: string; status: string; tone?: 'normal' | 'success' | 'warning' | 'danger' };

export type RecipeCookAssistantMessage = {
  id: string;
  role: 'user' | 'assistant' | 'system';
  text: string;
  tone?: 'normal' | 'success' | 'warning' | 'danger';
  parts?: RecipeCookAssistantMessagePart[];
};

export type RecipeCookSessionState = {
  currentStepIndex: number;
  checkedIngredientIds: string[];
  completedStepIds: string[];
  timers: CookTimerState[];
  activeTimerId: string;
  servings: string;
  date: string;
  mealType: MealType;
  createMealLog: boolean;
  planItemId: string | null;
  adjustments: string;
  resultNote: string;
  rating: string;
  aiAssistantMessages: RecipeCookAssistantMessage[];
};

export type RecipeShoppingIngredientOption = {
  id: string;
  name: string;
  unit: string;
  imageUrl: string;
  category: string;
  quantityMode: 'track_quantity' | 'not_track_quantity';
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

export type RecipeUnresolvedIngredientReason = 'missing_ingredient_id' | 'ingredient_not_found' | string;

export type RecipeUnresolvedIngredientItem = {
  index: number;
  ingredient_id?: string | null;
  ingredient_name: string;
  quantity?: number | string | null;
  unit: string;
  note?: string | null;
  reason: RecipeUnresolvedIngredientReason;
};

export type RecipeUnresolvedIngredientTarget = RecipeUnresolvedIngredientItem & {
  rowId: string | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object');
}

export function parseRecipeUnresolvedIngredientError(reason: unknown): RecipeUnresolvedIngredientItem[] | null {
  if (!isRecord(reason) || !isRecord(reason.payload)) return null;
  const detail = reason.payload.detail;
  if (!isRecord(detail) || detail.code !== 'recipe_unresolved_ingredients' || !Array.isArray(detail.items)) return null;
  const items = detail.items
    .filter(isRecord)
    .map((item) => ({
      index: Number(item.index ?? 0),
      ingredient_id: typeof item.ingredient_id === 'string' ? item.ingredient_id : null,
      ingredient_name: String(item.ingredient_name ?? '').trim(),
      quantity: typeof item.quantity === 'number' || typeof item.quantity === 'string' ? item.quantity : null,
      unit: String(item.unit ?? '').trim(),
      note: typeof item.note === 'string' ? item.note : '',
      reason: String(item.reason ?? 'missing_ingredient_id'),
    }))
    .filter((item) => Number.isFinite(item.index));
  return items.length > 0 ? items : null;
}

export function getRecipeSubmittedIngredientRows(rows: RecipeDraftIngredient[]) {
  return rows.filter((item) => item.ingredient_id || item.ingredient_name.trim());
}

export function buildRecipeUnresolvedIngredientTargets(
  items: RecipeUnresolvedIngredientItem[],
  rows: RecipeDraftIngredient[]
): RecipeUnresolvedIngredientTarget[] {
  const submittedRows = getRecipeSubmittedIngredientRows(rows);
  return items.map((item) => ({
    ...item,
    rowId: submittedRows[item.index]?.id ?? null,
  }));
}

export function buildRecipeIngredientCreatePayload(item: RecipeUnresolvedIngredientTarget) {
  const name = item.ingredient_name.trim() || '未命名食材';
  const defaultUnit = item.unit.trim() || '个';
  return {
    name,
    category: '未分类',
    default_unit: defaultUnit,
    unit_conversions: [],
    quantity_tracking_mode: 'track_quantity' as const,
    default_storage: '冷藏',
    default_expiry_mode: 'none',
    default_expiry_days: null,
    default_low_stock_threshold: null,
    notes: '从菜谱缺失食材创建',
    media_ids: [],
    pending_image_job_id: null,
  };
}

function getRecipeMediaIds(images: ImageInputValue) {
  return images.generatedAsset ? [images.generatedAsset.id] : [];
}

function parsePositiveNumber(value: number | string, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function isPresenceOnlyRecipeIngredient(item: RecipeDraftIngredient, ingredient: Ingredient | undefined) {
  const trackingSource = item.quantity_tracking_mode ? item : ingredient;
  return Boolean(item.ingredient_id && trackingSource && !tracksIngredientQuantity(trackingSource));
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
  | 'difficulty'
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
  | 'sort'
  | 'sparkle'
  | 'star'
  | 'tag'
  | 'utensils'
  | 'users'
  | 'view'
  | 'warning'
  | 'zap';

export function buildRecipePayload(
  form: RecipeFormState,
  rows: RecipeDraftIngredient[],
  ingredients: Ingredient[],
  pendingImageJobId?: string | null
): RecipePayload {
  return {
    title: form.title.trim(),
    servings: Number(form.servings),
    prep_minutes: parsePositiveNumber(form.prepMinutes, 20),
    difficulty: resolveRecipeDifficulty(form.difficulty),
    ingredient_items: rows
      .filter((item) => item.ingredient_id || item.ingredient_name.trim())
      .map((item) => {
        const ingredient = ingredients.find((entry) => entry.id === item.ingredient_id);
        const usesPresenceOnlyQuantity = isPresenceOnlyRecipeIngredient(item, ingredient);
        return {
          ingredient_id: item.ingredient_id || null,
          ingredient_name: ingredient?.name ?? item.ingredient_name.trim(),
          quantity: usesPresenceOnlyQuantity ? 1 : parsePositiveNumber(item.quantity, 1),
          unit: usesPresenceOnlyQuantity ? ingredient?.default_unit || item.unit.trim() || '份' : item.unit.trim() || ingredient?.default_unit || '个',
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
    ...(pendingImageJobId ? { pending_image_job_id: pendingImageJobId } : {}),
  };
}

export function formatCookQuantity(value: number) {
  return Number(value.toFixed(2)).toString().replace(/\.0+$/, '');
}

export function isPresenceShortage(item: Pick<CookRecipeShortage, 'shortage_type'>) {
  return item.shortage_type === 'presence';
}

type CookShortageDisplayInput = Pick<CookRecipeShortage, 'ingredient_name' | 'missing_quantity' | 'unit' | 'shortage_type'>;

export function formatCookShortageSummary(item: CookShortageDisplayInput) {
  if (isPresenceShortage(item)) {
    return `${item.ingredient_name} 需补充`;
  }
  return `${item.ingredient_name} ${formatCookQuantity(item.missing_quantity)}${item.unit}`;
}

export function formatCookShortageDetail(item: CookShortageDisplayInput) {
  if (isPresenceShortage(item)) {
    return '还没有可用库存记录，本次会先记录缺料提醒，不会扣减这项库存。';
  }
  return `还缺 ${formatCookQuantity(item.missing_quantity)}${item.unit}，本次会先扣减现有库存，缺少部分仅记录提醒。`;
}

export function formatCookPreviewRequestLabel(item: Pick<CookRecipePreviewItem, 'requested_quantity' | 'unit' | 'quantity_tracking_mode'>) {
  const requestedLabel = `${formatCookQuantity(item.requested_quantity)}${item.unit}`;
  return item.quantity_tracking_mode === 'not_track_quantity'
    ? `${requestedLabel} · 只判断有无`
    : requestedLabel;
}

export function getCookPreviewActionLabel(preview: Array<{ batches: readonly unknown[] }> | null | undefined) {
  return preview?.some((item) => item.batches.length > 0) ? '确认扣库存' : '确认完成';
}

export function getCookCompletionMessage(response: Pick<CookRecipeResponse, 'consumed_items' | 'shortages'>, createMealLog: boolean) {
  const deductedCount = response.consumed_items.filter((item) => item.affected_item_ids.length > 0).length;
  const hasPresenceOnlyItems = response.consumed_items.some((item) => item.quantity_tracking_mode === 'not_track_quantity');
  const shortageCount = response.shortages.length;
  const mealLogSuffix = createMealLog ? '并生成餐食记录' : '';
  const shortageSuffix = shortageCount > 0 ? `，还有 ${shortageCount} 项缺料已保留提醒` : '';

  if (deductedCount > 0 && hasPresenceOnlyItems) {
    return `已扣减数量库存${mealLogSuffix}${shortageSuffix}；只记录有无的食材未扣减数量。`;
  }
  if (deductedCount > 0) {
    return createMealLog ? `已扣减库存并生成餐食记录${shortageSuffix}。` : `已扣减库存${shortageSuffix}。`;
  }
  return createMealLog
    ? `已记录完成并生成餐食记录，本次没有需要扣减的数量库存${shortageSuffix}。`
    : `已记录完成，本次没有需要扣减的数量库存${shortageSuffix}。`;
}

export type CookFinishStepId = 'inventory' | 'meal' | 'feedback' | 'summary';
export type CookFinishStepStatus = 'completed' | 'skipped' | 'attention' | 'pending';

export function getCookFinishStepStatus(args: {
  stepId: CookFinishStepId;
  completedStepIds: readonly CookFinishStepId[];
  skippedStepIds: readonly CookFinishStepId[];
  hasInventoryAttention?: boolean;
}): CookFinishStepStatus {
  if (args.skippedStepIds.includes(args.stepId)) {
    return 'skipped';
  }
  if (args.stepId === 'inventory' && args.hasInventoryAttention) {
    return 'attention';
  }
  if (args.completedStepIds.includes(args.stepId)) {
    return 'completed';
  }
  return 'pending';
}

export function getCookFinishStepStatusLabel(status: CookFinishStepStatus) {
  if (status === 'completed') return '已完成';
  if (status === 'skipped') return '已跳过';
  if (status === 'attention') return '需留意';
  return '未处理';
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

export function buildDefaultCookSession(recipe: Pick<Recipe, 'servings' | 'steps'>, planItemId: string | null = null): RecipeCookSessionState {
  const firstStep = recipe.steps && recipe.steps[0];
  const firstStepSuggestedSeconds = firstStep ? getStepSuggestedSeconds(firstStep) : null;
  const isStepTimer = Boolean(firstStep && firstStepSuggestedSeconds);

  return {
    currentStepIndex: 0,
    checkedIngredientIds: [],
    completedStepIds: [],
    timers: [
      {
        id: 'default-timer',
        name: isStepTimer ? getRecipeStepTitle(firstStep, 0) : '自定义 1',
        seconds: 0,
        running: false,
        lastTickedAt: null,
        mode: firstStepSuggestedSeconds ? 'countdown' : 'countup',
        durationSeconds: firstStepSuggestedSeconds,
        source: isStepTimer ? 'step' : 'manual',
        stepId: isStepTimer ? firstStep.id : null,
      }
    ],
    activeTimerId: 'default-timer',
    servings: String(recipe.servings),
    date: todayKey(),
    mealType: 'dinner',
    createMealLog: true,
    planItemId,
    adjustments: '',
    resultNote: '',
    rating: '',
    aiAssistantMessages: [],
  };
}

export function sanitizeCookSession(
  value: unknown,
  recipe: Pick<Recipe, 'servings' | 'steps'>,
  planItemId: string | null = null
): RecipeCookSessionState {
  const fallback = buildDefaultCookSession(recipe, planItemId);
  if (!value || typeof value !== 'object') return fallback;
  const parsed = value as Partial<RecipeCookSessionState> & {
    timerSeconds?: unknown;
    timerRunning?: unknown;
    timerMode?: unknown;
    timerDurationSeconds?: unknown;
  };

  function resolveLegacyStep(timer: { name?: unknown; stepId?: unknown }) {
    if (typeof timer.stepId === 'string') {
      return recipe.steps.find((step) => step.id === timer.stepId) ?? null;
    }
    if (typeof timer.name !== 'string') return null;
    return recipe.steps.find((step, index) => {
      const title = getRecipeStepTitle(step, index);
      return timer.name === title || timer.name === `${title} 计时`;
    }) ?? null;
  }

  let timers: CookTimerState[] = Array.isArray(parsed.timers)
    ? parsed.timers.map((t: any, index): CookTimerState => {
        const legacyStep = resolveLegacyStep(t);
        const source = t.source === 'step' && legacyStep ? 'step' : t.source === 'manual' ? 'manual' : legacyStep ? 'step' : 'manual';
        return {
          id: typeof t.id === 'string' && t.id ? t.id : newDraftId('timer'),
          name: source === 'step' && legacyStep
            ? getRecipeStepTitle(legacyStep, recipe.steps.indexOf(legacyStep))
            : typeof t.name === 'string' && t.name ? t.name : `自定义 ${index + 1}`,
          seconds: Math.max(0, Number(t.seconds) || 0),
          running: Boolean(t.running),
          lastTickedAt: Number.isFinite(Number(t.lastTickedAt)) ? Number(t.lastTickedAt) : null,
          mode: t.mode === 'countdown' ? 'countdown' : 'countup',
          durationSeconds: Number(t.durationSeconds) > 0 ? Number(t.durationSeconds) : null,
          source,
          stepId: source === 'step' && legacyStep ? legacyStep.id : null,
        };
      })
    : [];

  if (timers.length === 0) {
    const currentStepIndex = clampStepIndex(Number(parsed.currentStepIndex) || 0, Math.max(recipe.steps.length, 1));
    const currentStep = recipe.steps[currentStepIndex] ?? null;
    const legacyDuration = Number(parsed.timerDurationSeconds) > 0 ? Number(parsed.timerDurationSeconds) : null;
    const isStepTimer = Boolean(currentStep && legacyDuration);
    timers = [
      {
        id: 'default-timer',
        name: isStepTimer ? getRecipeStepTitle(currentStep, currentStepIndex) : '自定义 1',
        seconds: Math.max(0, Number(parsed.timerSeconds) || 0),
        running: Boolean(parsed.timerRunning),
        lastTickedAt: null,
        mode: parsed.timerMode === 'countdown' ? 'countdown' : 'countup',
        durationSeconds: legacyDuration,
        source: isStepTimer ? 'step' : 'manual',
        stepId: isStepTimer ? currentStep.id : null,
      }
    ];
  }

  const activeTimerId = typeof parsed.activeTimerId === 'string' && timers.some((timer) => timer.id === parsed.activeTimerId)
    ? parsed.activeTimerId
    : timers[0].id;
  const advancedTimers = advanceCookTimers(timers);

  return {
    currentStepIndex: clampStepIndex(Number(parsed.currentStepIndex) || 0, Math.max(recipe.steps.length, 1)),
    checkedIngredientIds: Array.isArray(parsed.checkedIngredientIds) ? parsed.checkedIngredientIds.filter((item): item is string => typeof item === 'string') : [],
    completedStepIds: Array.isArray(parsed.completedStepIds) ? parsed.completedStepIds.filter((item): item is string => typeof item === 'string') : [],
    timers: advancedTimers.timers,
    activeTimerId: advancedTimers.newlyFinishedTimerId ?? activeTimerId,
    servings: typeof parsed.servings === 'string' && parsed.servings.trim() ? parsed.servings : fallback.servings,
    date: typeof parsed.date === 'string' && parsed.date ? parsed.date : fallback.date,
    mealType: MEAL_TYPE_OPTIONS.some((item) => item.value === parsed.mealType) ? parsed.mealType as MealType : fallback.mealType,
    createMealLog: typeof parsed.createMealLog === 'boolean' ? parsed.createMealLog : fallback.createMealLog,
    planItemId: typeof parsed.planItemId === 'string' ? parsed.planItemId : planItemId,
    adjustments: typeof parsed.adjustments === 'string' ? parsed.adjustments : '',
    resultNote: typeof parsed.resultNote === 'string' ? parsed.resultNote : '',
    rating: typeof parsed.rating === 'string' ? parsed.rating : '',
    aiAssistantMessages: Array.isArray(parsed.aiAssistantMessages)
      ? parsed.aiAssistantMessages
          .filter((item): item is RecipeCookAssistantMessage => Boolean(item && typeof item === 'object' && typeof item.id === 'string' && typeof item.role === 'string' && typeof item.text === 'string'))
          .slice(-40)
      : [],
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
    session: {
      ...session,
      timers: session.timers,
    },
  };
  writeJsonStorage(recipeCookSessionKey(recipeId, session.planItemId), persisted);
}

export function advanceCookTimers(timers: CookTimerState[], now: number = Date.now()) {
  let newlyFinishedTimerId: string | null = null;
  const nextTimers = timers.map((timer) => {
    if (!timer.running) return timer.lastTickedAt === null ? timer : { ...timer, lastTickedAt: null };

    const lastTickedAt =
      typeof timer.lastTickedAt === 'number' && Number.isFinite(timer.lastTickedAt) ? timer.lastTickedAt : now;
    const elapsedSeconds = Math.max(0, Math.floor((now - lastTickedAt) / 1000));
    if (elapsedSeconds <= 0) {
      return timer.lastTickedAt === lastTickedAt ? timer : { ...timer, lastTickedAt };
    }

    const nextLastTickedAt = lastTickedAt + elapsedSeconds * 1000;
    if (timer.mode === 'countdown' && timer.durationSeconds) {
      const nextSeconds = timer.seconds + elapsedSeconds;
      if (nextSeconds >= timer.durationSeconds) {
        newlyFinishedTimerId = timer.id;
        return {
          ...timer,
          running: false,
          seconds: timer.durationSeconds,
          lastTickedAt: null,
        };
      }
      return {
        ...timer,
        seconds: nextSeconds,
        lastTickedAt: nextLastTickedAt,
      };
    }

    return {
      ...timer,
      seconds: timer.seconds + elapsedSeconds,
      lastTickedAt: nextLastTickedAt,
    };
  });

  return { timers: nextTimers, newlyFinishedTimerId };
}

export function getNextManualTimerName(timers: Pick<CookTimerState, 'name'>[]) {
  const usedNumbers = new Set(
    timers
      .map((timer) => /^自定义 (\d+)$/.exec(timer.name)?.[1])
      .filter((value): value is string => Boolean(value))
      .map(Number)
  );
  let nextNumber = 1;
  while (usedNumbers.has(nextNumber)) nextNumber += 1;
  return `自定义 ${nextNumber}`;
}

export function transitionCookTimerForStep(args: {
  timers: CookTimerState[];
  activeTimerId: string;
  currentStepIndex: number;
  nextStepIndex: number;
  nextStep: RecipeStep | null | undefined;
  newTimerId: string;
}): { timers: CookTimerState[]; activeTimerId: string } {
  if (args.nextStepIndex === args.currentStepIndex) {
    return { timers: args.timers, activeTimerId: args.activeTimerId };
  }

  const suggestedSeconds = getStepSuggestedSeconds(args.nextStep);
  if (!args.nextStep || !suggestedSeconds) {
    return { timers: args.timers, activeTimerId: args.activeTimerId };
  }

  const existingStepTimer = args.timers.find((timer) => timer.source === 'step' && timer.stepId === args.nextStep?.id);
  if (existingStepTimer) {
    return { timers: args.timers, activeTimerId: existingStepTimer.id };
  }

  const activeTimer = args.timers.find((timer) => timer.id === args.activeTimerId) ?? args.timers[0];
  const stepName = getRecipeStepTitle(args.nextStep, args.nextStepIndex);
  if (activeTimer && !activeTimer.running && activeTimer.seconds === 0) {
    return {
      timers: args.timers.map((timer) => timer.id === activeTimer.id
        ? {
            ...timer,
            name: stepName,
            mode: 'countdown',
            durationSeconds: suggestedSeconds,
            lastTickedAt: null,
            source: 'step',
            stepId: args.nextStep?.id ?? null,
          }
        : timer),
      activeTimerId: activeTimer.id,
    };
  }

  const newTimer: CookTimerState = {
    id: args.newTimerId,
    name: stepName,
    seconds: 0,
    running: false,
    lastTickedAt: null,
    mode: 'countdown',
    durationSeconds: suggestedSeconds,
    source: 'step',
    stepId: args.nextStep.id,
  };
  return {
    timers: [...args.timers, newTimer],
    activeTimerId: newTimer.id,
  };
}

export function removeCookTimer(timers: CookTimerState[], activeTimerId: string, timerId: string) {
  const removedIndex = timers.findIndex((timer) => timer.id === timerId);
  if (removedIndex < 0 || timers.length <= 1) {
    return { timers, activeTimerId };
  }
  const nextTimers = timers.filter((timer) => timer.id !== timerId);
  if (activeTimerId !== timerId) {
    return { timers: nextTimers, activeTimerId };
  }
  const adjacentTimer = nextTimers[Math.min(removedIndex, nextTimers.length - 1)];
  return { timers: nextTimers, activeTimerId: adjacentTimer.id };
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
  allowPartialInventoryDeduction?: boolean;
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
    ...(args.allowPartialInventoryDeduction ? { allow_partial_inventory_deduction: true } : {}),
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
    const usesPresenceQuantity = item.shortageType === 'presence';
    return {
      id: `shortage-${item.ingredientId || item.ingredientName}`,
      ingredientId: item.ingredientId ?? null,
      title: item.ingredientName,
      quantity: usesPresenceQuantity ? '' : formatShoppingQuantity(Math.max(item.missingQuantity, 1)),
      unit: usesPresenceQuantity ? '' : item.unit,
      quantityMode: usesPresenceQuantity ? 'not_track_quantity' : 'track_quantity',
      displayLabel: usesPresenceQuantity ? '需要补充' : null,
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
    ingredientId: item.ingredient_id ?? null,
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
  const ingredientId = item.ingredientId?.trim() || null;
  const title = item.title.trim();
  const quantity = Number(item.quantity);
  if (!ingredientId || !title || !Number.isFinite(quantity) || quantity <= 0) return null;
  return {
    id: `custom-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    ingredientId,
    title,
    quantity: formatShoppingQuantity(quantity),
    unit: item.unit.trim() || '个',
    reason: `来自菜谱：${recipeTitle}`,
    source: 'custom',
    requirement: 'required',
  };
}

export function buildShoppingPayloadsFromDrafts(drafts: RecipeShoppingDraftItem[]): RecipeShoppingPayload[] {
  return drafts
    .flatMap((item) => {
      const usesPresenceQuantity = item.quantityMode === 'not_track_quantity';
      const ingredientId = item.ingredientId?.trim();
      const payload = {
        title: item.title.trim(),
        quantity: usesPresenceQuantity ? null : Number(item.quantity),
        unit: usesPresenceQuantity ? null : item.unit.trim() || '个',
        ingredient_id: ingredientId ?? '',
        quantity_mode: item.quantityMode ?? 'track_quantity',
        display_label: item.displayLabel ?? null,
        reason: item.reason.trim(),
      };
      if (
        !payload.title ||
        !payload.ingredient_id ||
        (payload.quantity_mode !== 'not_track_quantity' && (!Number.isFinite(payload.quantity) || payload.quantity === null || payload.quantity <= 0))
      ) {
        return [];
      }
      return [payload];
    })
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
  const quantityIsValid =
    item.quantity === undefined ||
    item.quantity === null ||
    (typeof item.quantity === 'number' && Number.isFinite(item.quantity));
  const unitIsValid = item.unit === undefined || item.unit === null || typeof item.unit === 'string';
  return (
    (typeof item.ingredient_id === 'string' || item.ingredient_id === null || item.ingredient_id === undefined) &&
    typeof item.ingredient_name === 'string' &&
    quantityIsValid &&
    unitIsValid &&
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
            quantity: item.quantity ?? '',
            unit: item.unit ?? '',
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
