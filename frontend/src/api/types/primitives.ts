/** Primitive/shared API contracts. Kept type-only to guarantee zero runtime cost. */
export type UserRole = 'Owner' | 'Member';
export type FoodType = 'selfMade' | 'takeout' | 'diningOut' | 'readyMade' | 'instant' | 'packaged';
export type MealType = 'breakfast' | 'lunch' | 'dinner' | 'snack';
export type Difficulty = 'easy' | 'medium' | 'hard';
export type InventoryStatus = 'fresh' | 'opened' | 'frozen' | 'expiring';
export type IngredientExpiryMode = 'days' | 'manual_date' | 'none';
export type AiMode = 'foodQa' | 'inventoryQa' | 'recommendation' | 'recipeDraft';
export type MediaSource = 'upload' | 'ai';
export type ImageGenerationMode = 'reference' | 'text';
export type MediaEntityType = 'user' | 'family' | 'ingredient' | 'food' | 'recipe' | 'recipe_scene' | 'food_scene' | 'meal_log';
