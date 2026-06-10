---
name: shopping-list
key: shopping_list
display_name: 购物清单
description: 根据餐食计划、库存缺口和待采购项生成或修改可确认的购物清单草稿。
allowed_tools:
  - shopping.read_pending
  - inventory.read_available_items
  - shopping.create_draft
context_policy:
  - shopping
  - inventory
  - artifacts
script_files:
  - scripts/merge_ingredients.py
  - scripts/normalize_ingredient.py
output_types: []
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
- 修改时必须引用真实 `shopping_list` artifact。
- `sourceDraftId` 只能使用已有草稿 ID 或当前运行的 `in_run:*` ID，不能编造。
- 使用 `script.normalize_ingredient` 归一化常见食材别名，使用 `script.merge_ingredients` 合并同名同单位项目。
- 扣除已有库存，并避免重复加入待采购项。
- 仅通过 `shopping.create_draft` 生成 `shopping_list` 草稿。
- 用户确认前不得写入正式 `ShoppingListItem`。
