export type UserRole = 'Owner' | 'Member';

export type FoodType = 'selfMade' | 'takeout' | 'diningOut' | 'readyMade' | 'instant' | 'packaged';

export type MealType = 'breakfast' | 'lunch' | 'dinner' | 'snack';

export type Difficulty = 'easy' | 'medium' | 'hard';

export type InventoryStatus = 'fresh' | 'opened' | 'frozen' | 'expiring';

export type AiMode = 'foodQa' | 'inventoryQa' | 'recommendation' | 'recipeDraft';

export type ActivityAction = 'create' | 'update' | 'invite' | 'switch';

export interface EntityMeta {
  id: string;
  createdAt: string;
  updatedAt: string;
  createdBy: string;
  updatedBy: string;
}

export interface Family extends EntityMeta {
  name: string;
  motto: string;
  location: string;
}

export interface User extends EntityMeta {
  name: string;
  email?: string;
  phone?: string;
  avatarSeed: string;
}

export interface Membership extends EntityMeta {
  familyId: string;
  userId: string;
  role: UserRole;
  status: 'active' | 'invited';
}

export interface ActivityLog {
  id: string;
  familyId: string;
  actorId: string;
  action: ActivityAction;
  entityType: string;
  entityId: string;
  summary: string;
  createdAt: string;
}

export interface PhotoAsset {
  id: string;
  name: string;
  url: string;
  source: 'upload' | 'ai';
  alt: string;
  generationMode?: 'reference' | 'text' | null;
  referenceMediaId?: string | null;
  styleKey?: string | null;
  promptVersion?: string | null;
  createdAt: string;
  createdBy: string;
}

export interface Ingredient extends EntityMeta {
  familyId: string;
  name: string;
  category: string;
  defaultUnit: string;
  defaultStorage: string;
  notes: string;
  image?: PhotoAsset;
}

export interface InventoryItem extends EntityMeta {
  familyId: string;
  ingredientId: string;
  quantity: number;
  unit: string;
  status: InventoryStatus;
  purchaseDate: string;
  expiryDate?: string;
  storageLocation: string;
  notes: string;
  lowStockThreshold: number;
}

export interface ShoppingListItem extends EntityMeta {
  familyId: string;
  title: string;
  quantity: number;
  unit: string;
  reason: string;
  done: boolean;
}

export interface RecipeIngredient {
  id: string;
  ingredientId?: string;
  ingredientName: string;
  quantity: number;
  unit: string;
  note: string;
}

export interface RecipeStep {
  id: string;
  title: string;
  text: string;
  icon?: string;
  summary?: string;
  estimatedMinutes?: number | null;
  tip?: string;
  keyPoints?: string[];
}

export interface Recipe extends EntityMeta {
  familyId: string;
  title: string;
  servings: number;
  prepMinutes: number;
  difficulty: Difficulty;
  ingredientItems: RecipeIngredient[];
  steps: RecipeStep[];
  tips: string;
  sceneTags: string[];
  images: PhotoAsset[];
}

export interface Food extends EntityMeta {
  familyId: string;
  name: string;
  type: FoodType;
  category: string;
  flavorTags: string[];
  suitableMealTypes?: MealType[];
  sourceName: string;
  purchaseSource?: string;
  scene: string;
  images: PhotoAsset[];
  notes: string;
  routineNote?: string;
  price?: number | null;
  rating?: number | null;
  repurchase?: boolean | null;
  expiryDate?: string;
  stockQuantity?: number | null;
  stockUnit?: string;
  favorite: boolean;
  recipeId?: string;
}

export interface MealLogFood {
  id: string;
  foodId: string;
  servings: number;
  note: string;
}

export interface InventoryDeductionSuggestion {
  id: string;
  ingredientName: string;
  suggestedAmount: number;
  unit: string;
  basedOnFoodName: string;
}

export interface MealLog extends EntityMeta {
  familyId: string;
  date: string;
  mealType: MealType;
  foodEntries: MealLogFood[];
  participantUserIds: string[];
  notes: string;
  mood: string;
  photos: PhotoAsset[];
  deductionSuggestions: InventoryDeductionSuggestion[];
}

export interface AIConversation {
  id: string;
  familyId: string;
  mode: AiMode;
  prompt: string;
  response: string;
  createdAt: string;
  createdBy: string;
  context: {
    foodId?: string;
    ingredientIds?: string[];
  };
}

export interface AIRecommendation {
  id: string;
  familyId: string;
  title: string;
  detail: string;
  createdAt: string;
}

export interface AppState {
  family: Family;
  users: User[];
  memberships: Membership[];
  foods: Food[];
  recipes: Recipe[];
  ingredients: Ingredient[];
  inventoryItems: InventoryItem[];
  shoppingList: ShoppingListItem[];
  mealLogs: MealLog[];
  activityLogs: ActivityLog[];
  aiConversations: AIConversation[];
  aiRecommendations: AIRecommendation[];
  currentUserId: string;
}

export interface ImageInputValue {
  referenceAsset?: PhotoAsset;
  generatedAsset?: PhotoAsset;
}

export interface OnboardingPayload {
  familyName: string;
  ownerName: string;
  members: string[];
}
