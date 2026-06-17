export interface AiWelcomeSuggestion {
  title: string;
  desc: string;
  prompt: string;
}

export const AI_WELCOME_SUGGESTIONS: AiWelcomeSuggestion[] = [
  {
    title: '🥬 新增食材',
    desc: '整理新的家庭常用食材档案',
    prompt: '帮我新增一个食材：秋葵，默认单位按根，常温保存',
  },
  {
    title: '📦 食材入库',
    desc: '把刚买回来的食材快速录入库存',
    prompt: '把今天买的鸡蛋 2 盒和牛奶 3 瓶录入库存',
  },
  {
    title: '🗓️ 修改计划',
    desc: '调整已有菜单计划的日期或内容',
    prompt: '把明天晚餐改成番茄炒蛋',
  },
  {
    title: '🛒 完成购物项',
    desc: '把已经买到的采购项标记完成',
    prompt: '把购物清单里的鸡蛋标记为已买',
  },
  {
    title: '🍲 修改菜谱',
    desc: '更新现有菜谱的份量或做法细节',
    prompt: '把番茄炒蛋改成 3 人份，并缩短准备时间',
  },
  {
    title: '🍽️ 记录餐食',
    desc: '补一条今天吃了什么的餐食记录',
    prompt: '记录今晚吃了番茄炒蛋和米饭',
  },
  {
    title: '🔥 开始烹饪',
    desc: '按现有菜谱开始做菜并检查库存',
    prompt: '开始做番茄炒蛋，先帮我检查库存并准备扣减',
  },
];
