/** Primitive/shared API contracts. Kept type-only to guarantee zero runtime cost. */
export type UserRole = 'Owner' | 'Member';
export type {
  FoodType,
  MealType,
  Difficulty,
  InventoryStatus,
  IngredientExpiryMode,
  AiMode,
  MediaSource,
  ImageGenerationMode,
  MediaEntityType,
} from '../types';
