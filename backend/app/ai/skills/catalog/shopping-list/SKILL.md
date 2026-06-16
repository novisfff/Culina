---
name: shopping-list
key: shopping_list
display_name: 购物清单
description: 根据餐食计划、库存缺口和待采购项生成或修改可确认的购物清单草稿。
allowed_tools:
  - intent.request_clarification
  - shopping.read_pending
  - shopping.read_by_id
  - inventory.read_available_items
  - shopping.create_draft
context_policy:
  - shopping
  - inventory
  - artifacts
script_files:
  - scripts/merge_ingredients.py
  - scripts/normalize_ingredient.py
output_types:
  - clarification_request
draft_types:
  - shopping_list
approval_policy: draft_then_confirm
can_continue_from:
  - meal_plan
  - shopping_list
intent: shopping
agent_key: shopping_agent
examples:
  - 生成购物清单。
  - 基于这个计划生成采购清单。
---

# 购物清单 Skill

## 执行规则

- 创建前读取待采购项和可用库存。
- 从计划派生时必须引用真实 `meal_plan` artifact。
- 修改和删除必须先读取真实购物项，并生成带 `action`、`targetId` 和 `baseUpdatedAt` 的操作草稿。
- 用户没有说明操作数量、存在多个近似待买项或需要确认是否标记买到时，调用 `intent.request_clarification`，并附上候选摘要。
- `sourceDraftId` 只能使用已有草稿 ID 或当前运行的 `in_run:*` ID，不能编造。
- 使用 `script.normalize_ingredient` 归一化常见食材别名，使用 `script.merge_ingredients` 合并同名同单位项目。
- 扣除已有库存，并避免重复加入待采购项。
- 仅通过 `shopping.create_draft` 生成 `shopping_list` 草稿。
- 修改、完成和恢复待买都必须生成带 `action`、`targetId` 和 `baseUpdatedAt` 的操作草稿。
- 购物状态变更使用 `set_done`，`done=true` 表示买到，`done=false` 表示恢复待买。
- 用户确认前不得写入正式 `ShoppingListItem`；确认后由后端根据操作类型执行 create、update 或 delete。
