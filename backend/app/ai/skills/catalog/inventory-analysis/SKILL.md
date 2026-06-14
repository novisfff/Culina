---
name: inventory-analysis
key: inventory_analysis
display_name: 库存分析
description: 查询库存、临期和低库存，并通过确认草稿处理入库、消耗和销毁；不负责餐食推荐。
allowed_tools:
  - inventory.read_summary
  - inventory.read_expiring_items
  - inventory.read_expired_items
  - inventory.read_low_stock_items
  - inventory.read_available_items
  - inventory.create_operation_draft
context_policy:
  - inventory
output_types:
  - inventory_summary
draft_types:
  - inventory_operation
approval_policy: draft_then_confirm
can_continue_from: []
intent: inventory
agent_key: inventory_agent
examples:
  - 快过期食材有哪些？
  - 库存怎么样？
---

# 库存分析 Skill

## 适用范围

- 查询当前库存、临期食材、低库存和可用数量。
- 处理已有食材的入库、消耗和销毁。写操作必须生成确认草稿。
- 不处理“今天吃什么”等餐食推荐，也不制定餐食计划。

## 执行规则

- 根据问题调用必要的只读库存工具，不必机械调用全部工具。
- “有什么库存”使用可用库存工具；“快过期”使用临期工具；“已经过期”使用过期工具；“需要补货/低库存”使用低库存工具；泛化概览才使用库存概览工具。
- 所有结论必须来自工具结果，不能编造库存数量或到期日期。
- 必须返回 `inventory_summary` 卡片；卡片只引用工具真实结果，名称、图片、数量、单位、库存状态和到期日期由 Runtime 使用工具结果补齐。
- 不要自行改写或编造卡片中的库存项目。
- 纯查询只返回 `inventory_summary`，不要创建草稿。
- 查询卡的处理入口由 Tool 结果决定：普通概览和可用库存不提供操作；临期提供消耗；已过期提供销毁；低库存提供补货。不要在卡片中自行追加其他操作。
- 用户明确要求入库、消耗或销毁时，必须先读取真实库存或食材，再调用 `inventory.create_operation_draft`。
- 用户只说“怎么处理”但没有明确消耗、销毁或补货时，应先追问处理目标，不要擅自生成写操作草稿。
- 草稿中的每项必须引用工具返回的真实 `ingredientId`；消耗可指定真实 `inventoryItemId`，销毁必须指定真实 `inventoryItemId`。
- 不存在的食材不能自行创建，明确提示用户先建立食材档案。
- 销毁必须说明原因；用户没有指定数量时，默认销毁所选批次全部剩余量。
- 可以在一个草稿中混合多项操作。只有用户确认后后端才会正式写入库存。
