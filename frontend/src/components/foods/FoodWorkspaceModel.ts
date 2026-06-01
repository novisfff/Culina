import type { Food, FoodPayload, FoodType, ImageInputValue, MealType, Recipe } from '../../api/types';
import type { AiRenderPayload } from '../../lib/aiImages';
import { FOOD_TYPE_LABELS, emptyImages, getFoodCover, splitTags } from '../../lib/ui';

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

function normalizeNumber(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

export function makeBlankFoodForm(type: FoodType = 'takeout'): FoodFormState {
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

export function foodToForm(food: Food): FoodFormState {
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

export function getFoodImagePayload(form: FoodFormState, recipes: Recipe[]): AiRenderPayload {
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

export function buildFoodSceneImagePayload(scene: { name: string; description: string; imagePrompt: string }): AiRenderPayload {
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

export function getFoodFormCompletionItems(form: FoodFormState, editingFood: Food | null, recipes: Recipe[] = []) {
  const hasImage = Boolean(form.images.generatedAsset || form.images.referenceAsset || (editingFood && getFoodCover(editingFood, recipes)));
  const items = [
    { label: form.type === 'selfMade' ? '关联菜谱' : '食物名称', done: form.type === 'selfMade' ? Boolean(form.recipeId) : Boolean(form.name.trim()) },
    { label: '适合餐别', done: form.suitableMealTypes.length > 0 },
    { label: '食物图片', done: hasImage },
    { label: '场景/备注', done: Boolean(form.routineNote.trim() || form.notes.trim() || splitTags(form.sceneTags).length > 0 || form.scene.trim()) },
  ];
  if (form.type === 'takeout' || form.type === 'diningOut') {
    items.push(
      { label: form.type === 'takeout' ? '店铺' : '餐厅', done: Boolean(form.sourceName.trim() || form.purchaseSource.trim()) },
      { label: '价格/评分', done: Boolean(form.price.trim() || form.rating.trim()) },
      { label: '复购意愿', done: form.repurchase !== 'unknown' }
    );
  }
  if (form.type === 'readyMade' || form.type === 'instant' || form.type === 'packaged') {
    items.push(
      { label: '购买渠道', done: Boolean(form.purchaseSource.trim() || form.sourceName.trim()) },
      { label: '剩余库存', done: Boolean(form.stockQuantity.trim() && form.stockUnit.trim()) },
      { label: '到期日期', done: Boolean(form.expiryDate) }
    );
  }
  return items;
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
