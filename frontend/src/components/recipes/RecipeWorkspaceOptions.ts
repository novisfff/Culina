import type { MealType } from '../../api/types';
import type { RecipeQuickFilter, RecipeSortMode } from './workspaceModel';

export const SHOW_RECIPE_PLAN_MANAGEMENT = false;

export const QUICK_FILTERS: Array<{ value: RecipeQuickFilter; label: string }> = [
  { value: 'recommend', label: '为你推荐' },
  { value: 'all', label: '全部' },
  { value: 'ready', label: '可做' },
  { value: 'quick', label: '快手' },
  { value: 'common', label: '常做' },
  { value: 'favorite', label: '收藏' },
  { value: 'missing', label: '缺料' },
];

export const SORT_OPTIONS: Array<{ value: RecipeSortMode; label: string }> = [
  { value: 'updated', label: '最近更新' },
  { value: 'availability', label: '匹配度' },
  { value: 'time', label: '准备时长' },
  { value: 'difficulty', label: '难度' },
];

export const MEAL_TYPE_OPTIONS: Array<{ value: MealType; label: string }> = [
  { value: 'breakfast', label: '早餐' },
  { value: 'lunch', label: '午餐' },
  { value: 'dinner', label: '晚餐' },
  { value: 'snack', label: '加餐' },
];

export const SHOPPING_UNIT_OPTIONS = ['个', '颗', '盒', '袋', '斤', '克', '瓶', '把', '份', '片'];
export const FALLBACK_SCENES = ['工作日晚餐', '孩子也能吃', '周末轻食', '高蛋白', '早餐', '汤羹'];
export const DUPLICATED_TYPE_LABELS = new Set(['全部', '为你推荐', '快手', '快手菜', '下饭菜', '缺料', '可做', '常做', '家常菜']);
export const OPTIONAL_INGREDIENT_NOTE_PATTERN = /^(?:可选|选用|装饰|替代|没有可不放)[：:\s、，,]*/;
export const MAX_STEP_KEY_POINTS = 3;

export const DISCOVERY_SECTION_COPY: Record<RecipeQuickFilter, { title: string; description: string; emptyTitle: string; emptyDescription: string }> = {
  all: {
    title: '全部菜谱',
    description: '按当前筛选条件浏览所有菜谱',
    emptyTitle: '没有匹配的菜谱',
    emptyDescription: '换个搜索或筛选条件试试。',
  },
  recommend: {
    title: '为你推荐',
    description: '根据库存、收藏和最近记录推荐',
    emptyTitle: '还没有可推荐的菜谱',
    emptyDescription: '先新增几份常做菜，之后会按库存和记录推荐。',
  },
  ready: {
    title: '可做菜谱',
    description: '优先展示当前库存更容易安排的菜谱',
    emptyTitle: '暂无可做菜谱',
    emptyDescription: '补充库存后，可直接做的菜谱会显示在这里。',
  },
  quick: {
    title: '快手',
    description: '适合 20 分钟内快速开饭',
    emptyTitle: '暂无快手菜',
    emptyDescription: '把准备时长设置在 20 分钟以内，就会归入快手菜。',
  },
  common: {
    title: '常做',
    description: '来自收藏、常做和高频餐食记录',
    emptyTitle: '暂无常做菜谱',
    emptyDescription: '收藏或多记录几次常吃菜谱后会自动聚合。',
  },
  favorite: {
    title: '我的收藏',
    description: '你收藏过、想优先安排的菜谱',
    emptyTitle: '还没有收藏菜谱',
    emptyDescription: '点亮菜谱卡片上的收藏，之后会集中显示在这里。',
  },
  missing: {
    title: '缺料菜谱',
    description: '这些菜谱需要先补齐部分食材',
    emptyTitle: '当前没有缺料菜谱',
    emptyDescription: '库存充足时这里会变少，可以切回为你推荐。',
  },
};

export const RECIPE_STEP_ICON_OPTIONS = [
  { value: 'pan', label: '炒锅' },
  { value: 'tomato', label: '食材' },
  { value: 'bowl', label: '调味' },
  { value: 'timer', label: '计时' },
  { value: 'tip', label: '提示' },
  { value: 'plate', label: '出锅' },
];

export const COOK_TIMER_PRESETS = [
  { label: '正计时', seconds: null },
  { label: '自定义', seconds: 'custom' as const },
  { label: '30秒', seconds: 30 },
  { label: '1分钟', seconds: 60 },
  { label: '2分钟', seconds: 120 },
  { label: '3分钟', seconds: 180 },
  { label: '5分钟', seconds: 300 },
  { label: '10分钟', seconds: 600 },
];
