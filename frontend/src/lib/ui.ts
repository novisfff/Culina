import type {
  Food,
  FoodType,
  ImageInputValue,
  Ingredient,
  InventoryItem,
  InventoryStatus,
  MealType,
  Recipe,
} from '../api/types';
import { getIngredientAvailableQuantityInDefault, getInventoryRemainingQuantity } from './ingredientUnits';

export const FOOD_TYPE_LABELS: Record<FoodType, string> = {
  selfMade: '自做菜',
  takeout: '外卖',
  diningOut: '外出就餐',
  packaged: '成品食品',
};

export const MEAL_TYPE_LABELS: Record<MealType, string> = {
  breakfast: '早餐',
  lunch: '午餐',
  dinner: '晚餐',
  snack: '加餐 / 夜宵',
};

export const INVENTORY_STATUS_LABELS: Record<InventoryStatus, string> = {
  fresh: '新鲜',
  opened: '已开封',
  frozen: '冷冻',
  expiring: '临期',
};

export const AI_MODE_LABELS = {
  foodQa: '单菜问答',
  inventoryQa: '库存问答',
  recommendation: '今日吃什么',
  recipeDraft: '菜谱草稿',
} as const;

export function todayKey() {
  const today = new Date();
  const year = today.getFullYear();
  const month = `${today.getMonth() + 1}`.padStart(2, '0');
  const day = `${today.getDate()}`.padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function splitTags(value: string): string[] {
  return value
    .split(/[,，、/；;\n]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

export function formatDate(date: string) {
  return new Intl.DateTimeFormat('zh-CN', {
    month: 'short',
    day: 'numeric',
    weekday: 'short',
  }).format(new Date(date));
}

export function formatDateTime(date: string) {
  return new Intl.DateTimeFormat('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(date));
}

export function formatRelativeDays(date: string) {
  const today = new Date(todayKey()).getTime();
  const target = new Date(date).getTime();
  const diff = Math.round((target - today) / (1000 * 60 * 60 * 24));
  if (diff === 0) return '今天';
  if (diff === 1) return '明天';
  if (diff > 1) return `${diff} 天后`;
  return `${Math.abs(diff)} 天前`;
}

export function avatarColor(seed: string): string {
  const palette = ['#d9895b', '#dd7a72', '#7f9d7c', '#6a90a6', '#caa15f', '#8e775f'];
  const index = [...seed].reduce((sum, char) => sum + char.charCodeAt(0), 0) % palette.length;
  return palette[index];
}

export function initials(name: string): string {
  return name.slice(0, 2).toUpperCase();
}

function svgDataUrl(svg: string): string {
  return `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`;
}

export function buildIngredientPlaceholderSvg(name: string): string {
  const label = name.trim() || '食材';
  const palette = [
    ['#f7eedf', '#dfbf96', '#b97b55', '#91a48a'],
    ['#f6efe6', '#d8b68d', '#c78053', '#95a294'],
    ['#f3eadc', '#d5b07c', '#bc744d', '#8da39a'],
    ['#f7f0e4', '#d7b99d', '#c68763', '#91a183'],
  ];
  const seed = [...label].reduce((sum, char) => sum + char.charCodeAt(0), 0);
  const [base, primary, secondary, accent] = palette[seed % palette.length];
  const offsetX = (seed % 44) - 22;
  const offsetY = (seed % 36) - 18;
  const ellipseTilt = (seed % 14) - 7;
  const svg = `
    <svg width="960" height="720" viewBox="0 0 960 720" fill="none" xmlns="http://www.w3.org/2000/svg">
      <rect width="960" height="720" rx="40" fill="url(#panel)"/>
      <rect width="960" height="720" rx="40" fill="${base}" fill-opacity="0.06"/>
      <circle cx="${248 + offsetX}" cy="${170 + offsetY / 2}" r="116" fill="white" fill-opacity="0.2"/>
      <circle cx="${724 - offsetX}" cy="${182 - offsetY / 3}" r="124" fill="${accent}" fill-opacity="0.08"/>
      <ellipse cx="${482 + offsetX / 3}" cy="${414 + offsetY / 3}" rx="224" ry="240" fill="${secondary}" fill-opacity="0.07"/>
      <ellipse cx="${424 + offsetX / 2}" cy="${404 + offsetY}" rx="134" ry="182" transform="rotate(${ellipseTilt} 424 404)" fill="white" fill-opacity="0.28"/>
      <ellipse cx="${554 - offsetX / 2}" cy="${390 - offsetY / 2}" rx="146" ry="190" transform="rotate(${-ellipseTilt} 554 390)" fill="${primary}" fill-opacity="0.22"/>
      <path d="M610 260C630.664 238.532 658.547 228.273 688.936 228.273C682.214 258.43 664.737 286.226 641.466 306.235C620.802 327.703 592.919 337.962 562.53 337.962C569.251 307.805 586.729 280.009 610 260Z" fill="white" fill-opacity="0.78"/>
      <path d="M556 292C573.275 274.057 596.588 265.483 621.987 265.483C616.367 290.698 601.751 313.938 582.286 330.674C565.01 348.617 541.697 357.191 516.298 357.191C521.919 331.976 536.534 308.736 556 292Z" fill="${accent}" fill-opacity="0.42"/>
      <ellipse cx="476" cy="402" rx="68" ry="94" fill="rgba(255,255,255,0.34)"/>
      <defs>
        <linearGradient id="panel" x1="44" y1="40" x2="916" y2="680" gradientUnits="userSpaceOnUse">
          <stop stop-color="${primary}"/>
          <stop offset="1" stop-color="${secondary}"/>
        </linearGradient>
      </defs>
    </svg>
  `.trim();

  return svgDataUrl(svg);
}

export function buildInventoryAlerts(
  inventoryItems: InventoryItem[],
  ingredients: Ingredient[]
): Array<{ id: string; title: string; detail: string; tone: 'warning' | 'danger' }> {
  const alerts: Array<{ id: string; title: string; detail: string; tone: 'warning' | 'danger' }> = [];
  const todayTime = new Date(todayKey()).getTime();

  for (const ingredient of ingredients) {
    if (ingredient.default_low_stock_threshold === null || ingredient.default_low_stock_threshold === undefined) {
      continue;
    }
    const availableQuantity = getIngredientAvailableQuantityInDefault(
      ingredient,
      inventoryItems.filter((item) => item.ingredient_id === ingredient.id && getInventoryRemainingQuantity(item) > 0),
      { excludeExpiredAt: todayKey() }
    );

    if (availableQuantity <= ingredient.default_low_stock_threshold) {
      alerts.push({
        id: `${ingredient.id}-low`,
        title: `${ingredient.name} 库存偏低`,
        detail: `当前可用 ${String(Number(availableQuantity.toFixed(2)))}${ingredient.default_unit}，建议补货`,
        tone: 'warning',
      });
    }
  }

  for (const item of inventoryItems) {
    if (getInventoryRemainingQuantity(item) <= 0) {
      continue;
    }
    const ingredient = ingredients.find((entry) => entry.id === item.ingredient_id);
    if (!ingredient) continue;
    const daysToExpiry = item.expiry_date
      ? Math.round((new Date(item.expiry_date).getTime() - todayTime) / (1000 * 60 * 60 * 24))
      : null;
    if (daysToExpiry !== null && daysToExpiry <= 2) {
      alerts.push({
        id: `${item.id}-expiry`,
        title: `${ingredient.name} ${daysToExpiry < 0 ? '已过期' : '即将到期'}`,
        detail: item.expiry_date ? `到期时间 ${formatDate(item.expiry_date)}，优先安排使用` : '建议尽快使用',
        tone: 'danger',
      });
    }
  }

  return alerts;
}

export function getFoodCover(food: Food, recipes: Recipe[]): string | undefined {
  return food.images[0]?.url ?? recipes.find((item) => item.id === food.recipe_id)?.images[0]?.url;
}

export function getRecipeCover(recipe: Recipe): string | undefined {
  return recipe.images[0]?.url;
}

export function getImagePreview(value: ImageInputValue) {
  return value.generatedAsset ?? value.referenceAsset;
}

export function emptyImages(): ImageInputValue {
  return {};
}

export function buildAiCoverSvg(title: string): string {
  const palette = ['#c5855b', '#d39674', '#cdaa78', '#8ca287', '#7798a7'];
  const seed = [...title].reduce((sum, char) => sum + char.charCodeAt(0), 0);
  const primary = palette[seed % palette.length];
  const secondary = palette[(seed + 2) % palette.length];
  const shiftX = (seed % 56) - 28;
  const shiftY = (seed % 40) - 20;
  const tilt = (seed % 16) - 8;
  return `
    <svg width="1200" height="800" viewBox="0 0 1200 800" fill="none" xmlns="http://www.w3.org/2000/svg">
      <rect width="1200" height="800" rx="72" fill="#faf4ed"/>
      <circle cx="${240 + shiftX}" cy="${180 + shiftY / 2}" r="180" fill="${secondary}" opacity="0.14"/>
      <circle cx="${980 - shiftX}" cy="${140 - shiftY / 3}" r="140" fill="${primary}" opacity="0.12"/>
      <circle cx="${920 - shiftX / 2}" cy="${620 + shiftY}" r="210" fill="${secondary}" opacity="0.12"/>
      <rect x="92" y="92" width="1016" height="616" rx="56" fill="url(#warm)"/>
      <ellipse cx="${590 + shiftX / 3}" cy="${440 + shiftY / 3}" rx="228" ry="236" fill="${secondary}" fill-opacity="0.08"/>
      <ellipse cx="${534 + shiftX / 2}" cy="${438 + shiftY}" rx="142" ry="184" transform="rotate(${tilt} 534 438)" fill="white" opacity="0.26"/>
      <ellipse cx="${664 - shiftX / 2}" cy="${428 - shiftY / 2}" rx="156" ry="194" transform="rotate(${-tilt} 664 428)" fill="${primary}" opacity="0.18"/>
      <path d="M770 268C794.105 242.945 826.646 230.968 862.105 230.968C854.264 266.166 833.879 298.61 806.738 321.95C782.633 347.005 750.092 358.982 714.633 358.982C722.474 323.784 742.859 291.34 770 268Z" fill="white" fill-opacity="0.8"/>
      <path d="M708 306C728.161 285.047 755.392 275.029 785.065 275.029C778.507 304.475 761.444 331.612 738.729 351.144C718.568 372.097 691.337 382.115 661.664 382.115C668.222 352.669 685.285 325.532 708 306Z" fill="${secondary}" fill-opacity="0.36"/>
      <ellipse cx="602" cy="438" rx="74" ry="102" fill="white" fill-opacity="0.28"/>
      <defs>
        <linearGradient id="warm" x1="92" y1="92" x2="1108" y2="708" gradientUnits="userSpaceOnUse">
          <stop stop-color="${primary}"/>
          <stop offset="1" stop-color="${secondary}"/>
        </linearGradient>
      </defs>
    </svg>
  `.trim();
}
