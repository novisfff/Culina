---
name: meal-planning
key: meal_plan
display_name: 餐食计划
description: 处理即时餐食推荐以及餐食计划的创建和修改；推荐返回今日推荐卡片，正式计划返回待确认草稿。
allowed_tools:
  - inventory.read_expiring_items
  - inventory.read_available_items
  - meal_log.read_recent
  - food.search
  - recipe.search
  - meal_plan.read_existing
  - meal_plan.create_draft
context_policy:
  - inventory
  - meal_logs
  - foods
  - recipes
  - meal_plan
script_files:
  - scripts/validate_meal_plan.py
  - scripts/render_plan_preview.py
output_types:
  - today_recommendation
draft_types:
  - meal_plan
approval_policy: draft_then_confirm
can_continue_from:
  - meal_plan
intent: meal_plan
agent_key: meal_plan_agent
examples:
  - 今晚吃什么？
  - 今天用现有食材推荐一下。
  - 安排三天晚餐。
  - 第二天不要鸡肉。
---

# 餐食计划 Skill

## 模式选择

### 即时推荐模式

- 适用于“今天吃什么”“今晚吃什么”“推荐一餐”等没有明确计划范围的请求。
- `quickTask=today_recommendation` 时必须使用此模式。
- 读取库存、临期食材、最近餐食，并按需查询食物和菜谱。
- 优先临期库存，尽量避免最近重复，返回 1–3 个当前家庭已有食物或菜谱候选。
- 返回 `today_recommendation` 卡片，不调用 `meal_plan.create_draft`，不创建审批。

### 正式计划模式

- 适用于“安排、制定、生成、修改餐食计划”，或用户给出日期、天数、餐别等计划范围的请求。
- 创建或修改时必须调用 `meal_plan.create_draft`，返回完整 `meal_plan` 草稿而不是 diff。
- 修改计划必须引用真实存在的 `meal_plan` artifact。

## 共同规则

- 所有推荐和计划都应参考当前库存、临期食材与最近餐食。
- 正式计划的 `items[].foodId` 必须来自 `food.search`，且标题必须使用对应食物名称。
- `items[].recipeId` 只能使用所选食物已关联的真实菜谱；没有关联时填 `null`。
- 如果正式计划需要的食物不在食物库中，说明需要先补充食物资料，不得创建无效草稿。
- 创建草稿前调用 `script.validate_meal_plan` 做确定性结构检查；需要文本预览时可调用 `script.render_plan_preview`。
- 不直接写入正式 `FoodPlanItem`，草稿确认后由后端完成写入。
