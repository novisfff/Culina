---
name: recipe-draft
key: recipe_draft
display_name: 菜谱草稿
description: 生成可编辑、可确认的结构化菜谱草稿。
allowed_tools:
  - ingredient.search
  - recipe.create_draft
context_policy:
  - ingredients
output_types: []
draft_types:
  - recipe
approval_policy: draft_then_confirm
can_continue_from:
  - recipe
intent: recipe_draft
agent_key: recipe_draft_agent
examples:
  - 帮我生成一份番茄鸡蛋面的菜谱。
  - 把这个菜谱补全。
---

# 菜谱草稿 Skill

## 执行规则

- 生成前调用 `ingredient.search` 获取当前家庭食材资料。
- `ingredient_items[].ingredient_id` 只能使用工具返回的真实 ID。
- 没有匹配食材时可以保留名称并将 `ingredient_id` 设为 `null`。
- 填写 `ingredient_id` 时，食材名称必须与该 ID 对应的名称一致。
- 生成完整、可执行的结构化菜谱，并通过 `recipe.create_draft` 校验。
- 仅生成 `recipe` 草稿，不直接创建正式 Recipe。
- 用户确认后由后端写入，模型不参与最终写入判断。
