import type {
  FoodType,
  MealLogCandidate,
  MealType,
  MediaAsset,
  RecordMealPayload,
  RecordMealTarget,
} from '../../api/types';
import { businessDateKey } from '../../lib/date';

export const MEAL_COMPOSER_FOOD_TYPES = ['selfMade', 'takeout', 'diningOut', 'readyMade'] as const;
export type MealComposerFoodType = (typeof MEAL_COMPOSER_FOOD_TYPES)[number];

export type ExistingComposerFood = {
  kind: 'existing';
  food_id: string;
  name: string;
  servings: number;
  cover?: MediaAsset | null;
};

export type NewComposerFood = {
  kind: 'new';
  client_food_id: string;
  name: string;
  type: MealComposerFoodType | FoodType;
  servings: number;
};

export type MealComposerFood = ExistingComposerFood | NewComposerFood;

export type CandidatePresentationMode = 'none' | 'single' | 'multi';

export type CandidatePresentation = {
  mode: CandidatePresentationMode;
  target: RecordMealTarget;
  selectedCandidateId: string | null;
  defaultsVisible: true;
  defaultsEditable: true;
};

export type MealComposerValidationIssue = {
  code: string;
  message: string;
  field?: string;
  client_food_id?: string;
  food_id?: string;
};

export class MealComposerValidationError extends Error {
  readonly issues: MealComposerValidationIssue[];

  constructor(issues: MealComposerValidationIssue[]) {
    super(issues.map((issue) => issue.message).join('; ') || '餐食记录草稿无效');
    this.name = 'MealComposerValidationError';
    this.issues = issues;
  }
}

const ALLOWED_FOOD_TYPE_SET = new Set<string>(MEAL_COMPOSER_FOOD_TYPES);

function isSnack(mealType: MealType): boolean {
  return mealType === 'snack';
}

function newestCandidate(candidates: MealLogCandidate[]): MealLogCandidate {
  return [...candidates].sort((left, right) => right.created_at.localeCompare(left.created_at))[0]!;
}

function existingTarget(candidate: MealLogCandidate): RecordMealTarget {
  return {
    kind: 'existing',
    meal_log_id: candidate.meal_log_id,
    expected_row_version: candidate.row_version,
  };
}

/**
 * Defaults from authoritative server candidates + meal type only.
 * All defaults remain visible/editable for the caller to surface before submit.
 */
export function deriveCandidatePresentation(
  candidates: MealLogCandidate[],
  mealType: MealType,
): CandidatePresentation {
  if (candidates.length === 0) {
    return {
      mode: 'none',
      target: { kind: 'new' },
      selectedCandidateId: null,
      defaultsVisible: true,
      defaultsEditable: true,
    };
  }

  if (candidates.length === 1) {
    const only = candidates[0]!;
    if (isSnack(mealType)) {
      return {
        mode: 'single',
        target: { kind: 'new' },
        selectedCandidateId: null,
        defaultsVisible: true,
        defaultsEditable: true,
      };
    }
    return {
      mode: 'single',
      target: existingTarget(only),
      selectedCandidateId: only.meal_log_id,
      defaultsVisible: true,
      defaultsEditable: true,
    };
  }

  if (isSnack(mealType)) {
    return {
      mode: 'multi',
      target: { kind: 'new' },
      selectedCandidateId: null,
      defaultsVisible: true,
      defaultsEditable: true,
    };
  }

  const newest = newestCandidate(candidates);
  return {
    mode: 'multi',
    target: existingTarget(newest),
    selectedCandidateId: newest.meal_log_id,
    defaultsVisible: true,
    defaultsEditable: true,
  };
}

function validateFoods(foods: MealComposerFood[]): MealComposerValidationIssue[] {
  const issues: MealComposerValidationIssue[] = [];
  if (foods.length === 0) {
    issues.push({
      code: 'empty_entries',
      message: '至少选择一道食物',
      field: 'entries',
    });
    return issues;
  }

  const seenFoodIds = new Set<string>();
  const seenClientFoodIds = new Set<string>();

  for (const food of foods) {
    if (food.kind === 'existing') {
      const foodId = food.food_id.trim();
      if (!foodId) {
        issues.push({
          code: 'missing_food_id',
          message: '已有食物缺少 food_id',
          field: 'food_id',
        });
        continue;
      }
      if (seenFoodIds.has(foodId)) {
        issues.push({
          code: 'duplicate_food',
          message: '同一食物不能重复加入一餐',
          field: 'food_id',
          food_id: foodId,
        });
      }
      seenFoodIds.add(foodId);
      continue;
    }

    const clientFoodId = food.client_food_id.trim();
    const name = food.name.trim();
    const type = food.type;

    if (!clientFoodId) {
      issues.push({
        code: 'missing_client_food_id',
        message: '临时食物缺少 client_food_id',
        field: 'client_food_id',
      });
    } else if (seenClientFoodIds.has(clientFoodId)) {
      issues.push({
        code: 'duplicate_client_food',
        message: '临时食物 ID 不能重复',
        field: 'client_food_id',
        client_food_id: clientFoodId,
      });
    } else {
      seenClientFoodIds.add(clientFoodId);
    }

    if (name.length < 1 || name.length > 120) {
      issues.push({
        code: 'invalid_food_name',
        message: '食物名称需为 1 至 120 个字符',
        field: 'name',
        client_food_id: clientFoodId || undefined,
      });
    }

    if (!ALLOWED_FOOD_TYPE_SET.has(type)) {
      issues.push({
        code: 'invalid_food_type',
        message: '快速记录仅支持家里做、外卖、外食或买来即食',
        field: 'type',
        client_food_id: clientFoodId || undefined,
      });
    }
  }

  return issues;
}

/**
 * Builds the record payload before any network call.
 * Throws MealComposerValidationError with typed issues when invalid.
 */
export function buildRecordMealPayload(args: {
  clientRequestId: string;
  date: string;
  mealType: MealType;
  target: RecordMealTarget;
  foods: MealComposerFood[];
}): RecordMealPayload {
  const issues = validateFoods(args.foods);
  if (issues.length > 0) {
    throw new MealComposerValidationError(issues);
  }

  const new_foods = args.foods
    .filter((food): food is NewComposerFood => food.kind === 'new')
    .map((food) => ({
      client_food_id: food.client_food_id.trim(),
      name: food.name.trim(),
      type: food.type as FoodType,
    }));

  const entries = args.foods.map((food) => {
    if (food.kind === 'existing') {
      return { food_id: food.food_id.trim(), servings: food.servings };
    }
    return { client_food_id: food.client_food_id.trim(), servings: food.servings };
  });

  return {
    client_request_id: args.clientRequestId,
    date: args.date,
    meal_type: args.mealType,
    target: args.target,
    new_foods,
    entries,
  };
}

/**
 * Returns a MediaAsset for resolveAssetUrl at render time. Never builds URLs.
 * Priority: first MealLog photo → first Food cover → null.
 */
export function selectMealPreviewMedia(args: {
  mealPhotos?: Array<MediaAsset | null | undefined> | null;
  foodCovers?: Array<MediaAsset | null | undefined> | null;
}): MediaAsset | null {
  for (const photo of args.mealPhotos ?? []) {
    if (photo) return photo;
  }
  for (const cover of args.foodCovers ?? []) {
    if (cover) return cover;
  }
  return null;
}

/** Business “today” for meal recording, fixed to Asia/Shanghai. */
export function createMealBusinessDate(instant: Date = new Date()): string {
  return businessDateKey(instant, 'Asia/Shanghai');
}
