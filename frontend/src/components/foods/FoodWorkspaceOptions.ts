import type { FoodType, MealType } from '../../api/types';
import type { FoodIconName } from './FoodWorkspacePrimitives';

export type FoodWorkspaceLens = 'all' | 'today' | 'selfMade' | 'outside' | 'ready' | 'expiring' | 'favorite' | 'needsInfo';
export type FoodGovernanceIssue = 'image' | 'meal' | 'note' | 'source' | 'stock';

export const FOOD_TYPE_OPTIONS: Array<{ value: FoodType; label: string }> = [
  { value: 'selfMade', label: '家常菜' },
  { value: 'takeout', label: '外卖' },
  { value: 'diningOut', label: '外食' },
  { value: 'readyMade', label: '成品' },
  { value: 'instant', label: '速食' },
];

export const FOOD_CREATE_TYPE_OPTIONS = FOOD_TYPE_OPTIONS.filter((item) => item.value !== 'selfMade');

export const FOOD_CREATE_TYPE_DETAILS: Partial<Record<FoodType, { icon: FoodIconName; description: string }>> = {
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
  { value: 'image', label: '缺图片', description: '补一张主图，卡片和记录更容易识别。' },
  { value: 'meal', label: '缺餐别', description: '设置早餐、午餐、晚餐或加餐，才能参与今日推荐。' },
  { value: 'note', label: '缺备注', description: '补场景标签、常用备注或复吃说明。' },
  { value: 'source', label: '缺来源', description: '补店铺、餐厅、品牌或购买渠道。' },
  { value: 'stock', label: '缺库存/到期', description: '成品速食需要数量、单位和到期日期。' },
];

export const FOOD_LENS_COPY: Record<FoodWorkspaceLens, { title: string; description: string; emptyTitle: string; emptyDescription: string }> = {
  all: {
    title: '全部食物',
    description: '完整浏览家里的食物资产，适合批量检查资料和复吃记录。',
    emptyTitle: '还没有食物',
    emptyDescription: '先新增一份外卖、成品或速食，家常菜会从菜谱自动沉淀。',
  },
  today: {
    title: '今晚吃什么',
    description: '优先显示适合午餐或晚餐的食物，用来快速安排今天这一餐。',
    emptyTitle: '还没有今晚可选',
    emptyDescription: '给食物补上午餐或晚餐餐别后，它们会出现在这里。',
  },
  selfMade: {
    title: '家常菜',
    description: '关注关联菜谱、复做次数和适合餐别，适合决定要不要自己做。',
    emptyTitle: '还没有家常菜',
    emptyDescription: '家常菜从菜谱同步而来，可以先去新增一份菜谱。',
  },
  outside: {
    title: '外卖外食',
    description: '关注店铺、价格、评分和复购意愿，适合决定要不要再吃一次。',
    emptyTitle: '还没有外卖外食',
    emptyDescription: '新增一份常点外卖或常去餐厅，之后就能快速复吃。',
  },
  ready: {
    title: '成品速食',
    description: '关注库存、到期和购买渠道，适合处理备用餐和临期食品。',
    emptyTitle: '还没有成品速食',
    emptyDescription: '新增常备成品或速食后，这里会帮助你看库存和到期。',
  },
  expiring: {
    title: '临期',
    description: '只看需要尽快处理的成品和速食。',
    emptyTitle: '没有临期食物',
    emptyDescription: '当前没有需要优先处理的成品或速食。',
  },
  favorite: {
    title: '收藏/常吃',
    description: '汇总收藏或复吃频率高的食物，适合低成本做决定。',
    emptyTitle: '还没有常吃食物',
    emptyDescription: '收藏食物或多记录几次，它们就会进入常吃视角。',
  },
  needsInfo: {
    title: '待完善',
    description: '集中补齐缺图片、缺来源、缺餐别或缺备注的食物。',
    emptyTitle: '资料都比较完整',
    emptyDescription: '当前没有明显缺少决策信息的食物。',
  },
};
