---
name: inventory-analysis
key: inventory_analysis
display_name: 库存分析
description: 查询库存概览、可用库存、临期、过期和低库存，并通过确认草稿处理已有食材的入库、消耗、销毁和本次单位换算；不创建食材档案、不保存副单位、不做餐食推荐或购物清单。
allowed_tools:
  - ingredient.search
  - ingredient.read_by_id
  - inventory.read_summary
  - inventory.read_expiring_items
  - inventory.read_expired_items
  - inventory.read_low_stock_items
  - inventory.read_available_items
  - intent.request_clarification
  - inventory.create_operation_draft
  - inventory.create_unit_conversion_operation_draft
context_policy:
  - inventory
output_types:
  - inventory_summary
  - clarification_request
draft_types:
  - inventory_operation
approval_policy: draft_then_confirm
intent: inventory
agent_key: inventory_agent
examples:
  - 快过期食材有哪些？
  - 库存怎么样？
  - 还有哪些菜能用的食材？
  - 鸡蛋入库 12 个，冷藏。
  - 做饭用了 2 个番茄，帮我扣库存。
  - 把过期的牛奶销毁掉。
---

# 库存分析 Skill

## 适用范围

- 查询当前库存、临期食材、低库存和可用数量。
- 处理已有食材的入库、消耗和销毁。写操作必须生成确认草稿。
- 不处理“今天吃什么”等餐食推荐，也不制定餐食计划。

## 自主决策空间

- 可以根据用户问题选择最小必要的库存读取工具，不需要机械调用全部库存工具。
- 纯查询时可以自由组织解释、摘要和处理建议，但库存名称、数量、单位、状态、到期日期必须来自工具结果。
- 入库、消耗和销毁的原因、备注等可编辑字段可以基于用户原话合理补全；数量、单位、批次和处理目标不明确时必须澄清。
- 目标唯一且工具结果明确时，不要重复追问；存在多个候选或会影响库存扣减/销毁结果时再请求用户选择。

## 执行规则

- “有什么库存”使用可用库存工具；“快过期”使用临期工具；“已经过期”使用过期工具；“需要补货/低库存”使用低库存工具；泛化概览才使用库存概览工具。
- 所有结论必须来自工具结果，不能编造库存数量或到期日期。
- 查询结果应返回 `inventory_summary` 卡片；即使模型漏写卡片，Runtime 也会基于库存读取结果补齐。卡片只引用工具真实结果，名称、图片、数量、单位、库存状态和到期日期由 Runtime 使用工具结果补齐。
- 不要自行改写或编造卡片中的库存项目。
- 纯查询只返回 `inventory_summary`，不要创建草稿。
- 查询卡的处理入口由 Tool 结果决定：普通概览和可用库存不提供操作；临期提供消耗；已过期提供销毁；低库存提供补货。不要在卡片中自行追加其他操作。
- 用户明确要求入库、消耗或销毁时，必须先读取真实库存或食材，再调用 `inventory.create_operation_draft`。
- 入库必须先用 `ingredient.search` 或 `ingredient.read_by_id` 确认真实食材、`defaultUnit`、`supportedUnits` 和 `unitConversions`，再决定下一步。
- 如果用户使用的入库单位已经在该食材 `supportedUnits` 中，按用户原单位调用 `inventory.create_operation_draft`。
- 如果用户使用的入库单位不在该食材 `supportedUnits` 中，不要调用 `inventory.create_operation_draft` 试错；改调用 `intent.request_clarification`，`questionType` 使用 `unit_conversion`，并提供 `unitMismatch`：`ingredientId`、`ingredientName`、`defaultUnit`、`unsupportedUnit`、`supportedUnits`、`originalDraft`。
- 单位换算澄清文案使用：“{食材名}当前主单位是 {主单位}，尚未设置 {用户单位}。请确认这次 1 {用户单位} 等于多少 {主单位}；确认后只按本次换算继续入库，不会自动保存为副单位。”
- 如果用户输入中带有 `pendingClarification`，且 `sourceSkill` 是 `inventory_analysis`、`questionType` 是 `unit_conversion`：结合完整对话判断当前回复是否在补充本次换算。
- 当前回复明确给出了“1 个不支持单位 = N 个主单位”时，调用 `inventory.create_unit_conversion_operation_draft`，传入原始 `pendingClarification` 和 `ratioToDefault`；该草稿只按本次换算入库，不保存副单位。
- 当前回复无法确定换算比例时，继续调用 `intent.request_clarification` 追问；如果用户明显换了话题，不要强行处理单位换算，按当前消息完成本 Skill 适用的任务或由 Planner 路由到其他 Skill。
- 如果用户后续明确要求“保存副单位/以后都按这个算”，不要在本 Skill 中调用未授权工具或用规则兜底。本 Skill 只能说明需要进入食材档案流程；由 Planner 下一步路由到 `ingredient_profile` 后，读取真实食材信息并通过 `ingredient_profile.create_draft` 生成单独审批。
- 用户只说“怎么处理”但没有明确消耗、销毁或补货时，应先追问处理目标，不要擅自生成写操作草稿。
- 数量、批次或处理目标不明确时，调用 `intent.request_clarification`，并提供候选批次摘要。
- 草稿中的每项必须引用工具返回的真实 `ingredientId`；消耗可指定真实 `inventoryItemId`，销毁必须指定真实 `inventoryItemId`。
- 不存在的食材不能自行创建，明确提示用户先建立食材档案。
- 销毁必须说明原因；用户没有指定数量时，默认销毁所选批次全部剩余量。
- 可以在一个草稿中混合多项操作。只有用户确认后后端才会正式写入库存。
