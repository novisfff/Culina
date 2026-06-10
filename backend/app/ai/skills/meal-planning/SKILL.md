---
name: meal-planning
key: meal_plan
display_name: 餐食计划
version: 1.0.0
description: 基于库存、最近餐食、已有食物和菜谱生成或修改可编辑餐食计划草稿。
category: planning
runner: toolcall
risk_level: medium
allowed_tools:
  - inventory.read_expiring_items
  - inventory.read_available_items
  - meal_log.read_recent
  - food.search
  - recipe.search
  - meal_plan.read_existing
  - meal_plan.create_draft
forbidden_tools:
  - meal_plan.commit
  - inventory.consume
requires_confirmation:
  - meal_plan.create
  - meal_plan.update
context_policy:
  - inventory
  - meal_logs
  - foods
  - recipes
  - meal_plan
workflow_files:
  - workflows.md
hitl_files:
  - hitl.md
example_files:
  - examples.md
script_files:
  - scripts/validate_meal_plan.py
output_contract: SkillExecutionResult
output_types: []
draft_types:
  - meal_plan
approval_policy: draft_then_confirm
can_continue_from:
  - meal_plan
intent: meal_plan
agent_key: meal_plan_agent
examples:
  - 安排三天晚餐。
  - 第二天不要鸡肉。
---

# 餐食计划 Skill

## 目标

根据家庭库存、临期食材、最近餐食、已有食物和菜谱，生成可执行的餐食建议或可确认的餐食计划草稿。

## 工具使用规则

- 生成计划前读取库存、临期、最近餐食、食物和菜谱。
- 修改计划时必须引用真实存在的 `meal_plan` 草稿 artifact。
- 草稿 `items[].foodId` 必须来自 `food.search` 返回的当前家庭食物，不能为空。
- 草稿 `items[].title` 必须使用所选 `foodId` 对应的食物名称，不能生成食物库外的新名称。
- 草稿 `items[].recipeId` 只能使用所选食物已经关联的 `recipeId`；没有关联菜谱时填 `null`。
- 如果用户想安排的食物不在 `food.search` 可选项中，先说明需要到食物库补充资料，不要调用 `meal_plan.create_draft`。
- 返回完整计划，不返回 diff。
- 只允许调用 `meal_plan.create_draft` 生成草稿。
- 不得写正式 `FoodPlanItem`。

## 输出格式

生成草稿时，`draft_type` 必须是 `meal_plan`。每条计划项必须包含 `date`、`mealType`、`title`、`foodId`，其中 `foodId` 是当前家庭食物库已有食物 ID。
