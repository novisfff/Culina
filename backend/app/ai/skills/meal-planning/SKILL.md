---
name: meal-planning
key: meal_plan
display_name: 餐食计划
version: 1.0.0
description: 基于库存、最近餐食和已有菜谱生成或修改可编辑餐食计划草稿。
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
  - scripts/render_plan_preview.py
output_contract: SkillExecutionResult
output_types:
  - meal_plan_draft
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
- 返回完整计划，不返回 diff。
- 只允许调用 `meal_plan.create_draft` 生成草稿。
- 不得写正式 `FoodPlanItem`。

## 输出格式

生成草稿时，`draft_type` 必须是 `meal_plan`。
