---
name: food-profile
display_name: 食物资料
version: 1.0.0
description: 把自然语言食物描述整理为可确认的食物资料草稿。
category: food
runner: toolcall
risk_level: medium
allowed_tools:
  - food.search
  - food_profile.create_draft
forbidden_tools:
  - food_profile.commit
requires_confirmation:
  - food_profile.create
context_policy:
  - foods
workflow_files:
  - workflows.md
hitl_files:
  - hitl.md
example_files:
  - examples.md
script_files: []
output_contract: SkillExecutionResult
output_types: []
draft_types:
  - food_profile
approval_policy: draft_then_confirm
can_continue_from:
  - food_profile
intent: food_profile
agent_key: food_profile_agent
examples:
  - 整理食物资料 蓝莓酸奶。
  - 新增食物资料。
---

# 食物资料 Skill

## 目标

把用户描述的食物整理成可编辑、可确认的食物资料草稿。

## 工具使用规则

- 先读取家庭食物资料。
- 同名食物可复用已有字段。
- 如果设置 `recipe_id`，必须来自当前家庭真实存在的菜谱；不要编造菜谱 ID。
- 引用已有食物或菜谱时，名称必须与已选对象保持一致，不能把一个 ID 配给另一个名称。
- 不编造品牌、价格、评分、库存或过期日期。
- 只生成 `food_profile` 草稿。
- 不直接写 Food。
