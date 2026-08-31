import type { FoodType, MealType } from '../../api/types/food';
import type { FoodIconName } from './FoodWorkspacePrimitives';

export type FoodWorkspaceLens = 'all' | 'today' | 'selfMade' | 'outside' | 'ready' | 'expiring' | 'favorite' | 'needsInfo';
export type FoodGovernanceIssue = 'image' | 'meal' | 'note' | 'source' | 'stock';

export const FOOD_QUICK_VIEW_OPTIONS: Array<{ value: FoodWorkspaceLens; label: string }> = [
  { value: 'all', label: '全部' },
  { value: 'selfMade', label: '家常菜' },
  { value: 'outside', label: '外卖外食' },
  { value: 'ready', label: '成品速食' },
];

export const MOBILE_DEFAULT_FOOD_SCENES = [
  { key: 'protein', title: '高蛋白', fallbackIndex: 0 },
  { key: 'dinner', title: '工作日晚餐', fallbackIndex: 1 },
  { key: 'kid', title: '孩子也能吃', fallbackIndex: 2 },
  { key: 'light', title: '周末轻食', fallbackIndex: 3 },
];

export const FOOD_TYPE_OPTIONS: Array<{ value: FoodType; label: string }> = [
  { value: 'selfMade', label: '家常菜' },
  { value: 'takeout', label: '外卖' },
  { value: 'diningOut', label: '外食' },
  { value: 'readyMade', label: '成品' },
  { value: 'instant', label: '速食' },
];

export const FOOD_CREATE_TYPE_OPTIONS: Array<{ value: FoodType; label: string }> = [
  { value: 'selfMade', label: '自己做' },
  ...FOOD_TYPE_OPTIONS.filter((item) => item.value !== 'selfMade'),
];

export const FOOD_CREATE_TYPE_DETAILS: Partial<Record<FoodType, { icon: FoodIconName; description: string }>> = {
  selfMade: { icon: 'home', description: '在家现做' },
  takeout: { icon: 'receipt', description: '常点店铺' },
  diningOut: { icon: 'tag', description: '餐厅记录' },
  readyMade: { icon: 'bowl', description: '即开即吃' },
  instant: { icon: 'clock', description: '备用速食' },
};

export const MEAL_OPTIONS: Array<{ value: MealType; label: string }> = [
  { value: 'breakfast', label: '早餐' },
  { value: 'lunch', label: '午餐' },
  { value: 'dinner', label: '晚餐' },
  { value: 'snack', label: '加餐' },
];

export const FOOD_GOVERNANCE_ISSUE_OPTIONS: Array<{ value: FoodGovernanceIssue; label: string; description: string }> = [
  { value: 'stock', label: '需要补充库存或到期日', description: '为成品速食补上数量、单位和到期日。' },
  { value: 'meal', label: '需要补充餐别', description: '设置早餐、午餐、晚餐或加餐，才能参与今日推荐。' },
  { value: 'source', label: '需要补充来源', description: '补上店铺、餐厅、品牌或购买渠道。' },
  { value: 'image', label: '需要补充图片', description: '补一张主图，卡片和记录更容易识别。' },
  { value: 'note', label: '需要补充备注', description: '补上场景标签、常用备注或常吃说明。' },
];

export const FOOD_LENS_COPY: Record<FoodWorkspaceLens, { title: string; description: string; emptyTitle: string; emptyDescription: string }> = {
  all: {
    title: '全部食物',
    description: '完整浏览家里的食物和用餐记录。',
    emptyTitle: '还没有食物',
    emptyDescription: '先新增一份外卖、成品或速食；保存菜谱后，家常菜会自动出现在这里。',
  },
  today: {
    title: '今天吃什么',
    description: '优先显示适合午餐或晚餐的食物，用来快速安排今天这一餐。',
    emptyTitle: '今天还没有可选食物',
    emptyDescription: '给食物补上午餐或晚餐餐别后，它们会出现在这里。',
  },
  selfMade: {
    title: '家常菜',
    description: '关注菜谱与用料、做过次数和适合餐别，帮你决定要不要自己做。',
    emptyTitle: '还没有家常菜',
    emptyDescription: '先补一份家常菜谱，保存后会自动出现在食物库。',
  },
  outside: {
    title: '外卖外食',
    description: '关注店铺、价格、评分和下次是否还想吃，帮你决定要不要再安排。',
    emptyTitle: '还没有外卖外食',
    emptyDescription: '新增一份常点外卖或常去餐厅，之后就能快速安排下一次。',
  },
  ready: {
    title: '成品速食',
    description: '关注库存、到期和购买渠道，方便安排备用餐并及时处理临期食品。',
    emptyTitle: '还没有成品速食',
    emptyDescription: '新增常备成品或速食后，这里会显示库存和到期情况。',
  },
  expiring: {
    title: '临期',
    description: '只看需要尽快处理的成品和速食。',
    emptyTitle: '没有临期食物',
    emptyDescription: '当前没有需要优先处理的成品或速食。',
  },
  favorite: {
    title: '收藏与常吃',
    description: '汇总收藏和经常吃的食物，帮你更快做决定。',
    emptyTitle: '还没有常吃食物',
    emptyDescription: '收藏食物或多记录几次，它们就会出现在这里。',
  },
  needsInfo: {
    title: '需要完善',
    description: '集中补充库存、到期日、餐别、来源、图片或备注。',
    emptyTitle: '信息已补齐',
    emptyDescription: '当前没有明显需要补充关键信息的食物。',
  },
};
