---
name: shopping-list
display_name: 购物清单
version: 1.0.0
description: 基于餐食计划、库存缺口和低库存生成购物清单草稿。
category: shopping
runner: shopping_list
risk_level: medium
allowed_tools:
  - shopping.read_pending
  - inventory.read_available_items
  - shopping.create_draft
  - shopping_list.create_draft
forbidden_tools:
  - shopping_list.commit
requires_confirmation:
  - shopping_list.create
context_policy:
  - shopping
  - inventory
  - artifacts
workflow_files:
  - workflows.md
hitl_files:
  - hitl.md
example_files:
  - examples.md
script_files:
  - scripts/merge_ingredients.py
  - scripts/normalize_ingredient.py
output_contract: SkillExecutionResult
output_types:
  - shopping_list_draft
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

## 目标

根据餐食计划、库存缺口和待采购项生成可编辑购物清单草稿。

## 工具使用规则

- derive 必须引用真实 `meal_plan` artifact。
- modify 必须引用真实 `shopping_list` artifact。
- 必须合并重复项。
- 已有库存不要重复采购。
- 只生成草稿，不写正式 `ShoppingListItem`。
