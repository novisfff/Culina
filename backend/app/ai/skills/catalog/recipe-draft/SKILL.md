---
name: recipe-draft
key: recipe_draft
display_name: 菜谱管理
description: 生成、更新、删除和收藏可确认的菜谱操作草稿。
allowed_tools:
  - ingredient.search
  - intent.request_clarification
  - recipe.search
  - recipe.read_by_id
  - recipe.create_draft
context_policy:
  - ingredients
output_types:
  - clarification_request
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
- 更新这个菜谱。
- 删除这份菜谱。
---

# 菜谱管理 Skill

## 执行规则

- 生成前调用 `ingredient.search` 获取当前家庭食材资料。
- 更新、删除和收藏前先通过 `recipe.search` 或 `recipe.read_by_id` 确认真实目标。
- 多个相似菜谱、删除存在影响、或用户没有说明份数/目标时，调用 `intent.request_clarification`，并给出候选摘要或影响摘要。
- `ingredient_items[].ingredient_id` 只能使用工具返回的真实 ID。
- 没有匹配食材时可以保留名称并将 `ingredient_id` 设为 `null`。
- 填写 `ingredient_id` 时，食材名称必须与该 ID 对应的名称一致。
- 新增可以生成结构化菜谱草稿。
- 更新、删除和收藏必须生成带 `action`、`targetId` 和 `baseUpdatedAt` 的操作草稿。
- 删除审批必须展示删除影响，包括同步食物、计划项、烹饪记录和媒体处理。
- 仅通过 `recipe.create_draft` 生成 `recipe` 草稿，不直接写正式 `Recipe` 或收藏关系。
- 用户确认后由后端按操作类型写入，模型不参与最终写入判断。
