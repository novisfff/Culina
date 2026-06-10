---
name: food-profile
key: food_profile
display_name: 食物资料
description: 把自然语言食物描述整理为可编辑、可确认的食物资料草稿。
allowed_tools:
  - food.search
  - food_profile.create_draft
context_policy:
  - foods
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

## 适用范围

- 用户要新增、整理或补全食物资料。
- 不用于创建菜谱、记录用餐或安排餐食计划。

## 执行规则

- 先调用 `food.search`，检查当前家庭已有食物并复用同名食物字段。
- 如果设置 `recipe_id`，必须来自当前家庭真实菜谱；名称必须与所选菜谱一致。
- 不编造品牌、价格、评分、库存、过期日期或业务 ID。
- 信息不足时追问，不要用猜测填充关键字段。
- 仅通过 `food_profile.create_draft` 生成 `food_profile` 草稿。
- 草稿需要用户确认；确认前不得写入正式 Food。
