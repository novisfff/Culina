---
name: inventory-analysis
description: 查询家庭库存概览、可用库存、临期、过期和低库存；库存查询包含食材库存以及成品/速食食物库存；食材入库、消耗和销毁通过确认草稿处理。
---

# 库存分析 Skill

## 适用范围

- 查询当前库存、临期食材、低库存和可用数量。
- 查询家庭库存时同时覆盖两类库存：食材库存来自 `InventoryItem`，成品/速食库存来自食物资料中的 `stock_quantity`、`stock_unit` 和 `expiry_date`。
- 成品/速食库存只用于“家里还有什么、什么快过期、今天可直接吃什么”的库存判断；不能当作菜谱原料，也不能替代真实食材 ID。
- 低库存仅针对食材库存，因为 phase one 里食物库存还没有低库存阈值。
- 处理已有食材的入库、消耗和销毁。写操作必须生成确认草稿。
- 不处理“今天吃什么”等餐食推荐，也不制定餐食计划。

## 自主决策空间

- 可以根据用户问题选择最小必要的库存读取工具，不需要机械调用全部库存工具。
- 纯查询时可以自由组织解释、摘要和处理建议，但库存名称、数量、单位、状态、到期日期必须来自工具结果。
- 入库、消耗和销毁的原因、备注等可编辑字段可以基于用户原话合理补全；数量、单位或处理目标不明确时必须澄清。
- 消耗库存时，如果用户只指定食材、数量和单位，没有指定具体批次，可以不填写 `inventoryItemId`，直接调用 `inventory.create_operation_draft` 生成确认草稿；后端会按到期日、采购日和创建时间的顺序扣减可用批次，并在草稿里展示候选批次。
- 目标唯一且工具结果明确时，不要重复追问；只有用户明确要求处理某一批但描述无法对应、库存不足、单位无法换算，或处理目标不明确时才请求用户选择。

## 字段取值规则

- `operations[].action` 只能是 `restock`、`consume`、`dispose`；不要输出“补货”“扣减”“扔掉”等中文自由值。
- 入库 `status` 只能是 `fresh`、`opened`、`frozen`、`expiring`；没有明确开封、冷冻或临期时默认 `fresh`，但到期日期仍必须来自用户输入、食材规则或留空。
- `storageLocation` 优先使用食材默认保存位置或前端保存位置预设：`冷藏`、`冷冻`、`常温`；只有用户明确给出家庭自定义位置时才自定义。
- `unit` 优先使用食材 `supportedUnits`。用户单位不支持时，必须走本次换算追问或 `inventory.create_unit_conversion_operation_draft`，不要调用 `inventory.create_operation_draft` 试错。
- `dispose` 必须绑定真实库存批次并填写原因；`consume` 可以省略批次让后端按默认顺序扣减；`restock` 必须绑定真实食材。
- 低库存阈值、保质期天数、到期日期等没有证据时不要编造。

## 执行规则

- “有什么库存”使用可用库存工具；“快过期”使用临期工具；“已经过期”使用过期工具；“需要补货/低库存”使用低库存工具；泛化概览才使用库存概览工具。
- 可用、临期、过期工具都可以返回成品/速食库存；低库存工具只返回食材库存，不返回食物库存。
- 所有结论必须来自工具结果，不能编造库存数量或到期日期。
- 查询结果应通过会返回 `card` 的库存读取工具产出 `inventory_summary` 卡片；不要自造卡片 JSON，也不要依赖 Runtime 事后补齐。
- 不要自行改写或编造卡片中的库存项目。
- 纯查询只返回 `inventory_summary`，不要创建草稿。
- 如果用户要修改成品/速食的库存数量、到期日或购买渠道，不要调用 `inventory.create_operation_draft`，因为它只处理真实食材库存。应说明这是食物资料库存，并让 Orchestrator 进入 `food_profile` 流程生成 food_profile 更新草稿。
- 查询卡的处理入口由 Tool 结果决定：普通概览和可用库存不提供操作；临期提供消耗；已过期提供销毁；低库存提供补货。不要在卡片中自行追加其他操作。
- 用户明确要求入库、消耗或销毁时，必须先读取真实库存或食材，再调用 `inventory.create_operation_draft`。
- 入库必须先用 `ingredient.search` 或 `ingredient.read_by_id` 确认真实食材、`defaultUnit`、`supportedUnits` 和 `unitConversions`，再决定下一步。
- 如果用户使用的入库单位已经在该食材 `supportedUnits` 中，按用户原单位调用 `inventory.create_operation_draft`。
- 如果用户使用的入库单位不在该食材 `supportedUnits` 中，不要调用 `inventory.create_operation_draft` 试错；调用 `human.request_input` 追问本次换算比例，`resumeHint.questionType` 使用 `unit_conversion`，并在 `resumeHint.unitMismatch` 提供：`ingredientId`、`ingredientName`、`defaultUnit`、`unsupportedUnit`、`supportedUnits`、`originalDraft`。
- 单位换算澄清文案使用：“{食材名}当前主单位是 {主单位}，尚未设置 {用户单位}。请确认这次 1 {用户单位} 等于多少 {主单位}；确认后只按本次换算继续入库，不会自动保存为副单位。”
- 如果当前运行的 artifacts 中有 `human.input_result`，且 `request.resumeHint.questionType` 是 `unit_conversion`：结合用户回复判断是否在补充本次换算。
- 当前回复明确给出了“1 个不支持单位 = N 个主单位”时，调用 `inventory.create_unit_conversion_operation_draft`，传入 `resumeHint.unitMismatch` 和 `ratioToDefault`；该草稿只按本次换算入库，不保存副单位。
- 当前回复无法确定换算比例时，继续调用 `human.request_input` 追问单位换算；如果用户明显换了话题，不要强行处理单位换算，按当前消息完成本 Skill 适用的任务或由 Orchestrator 注入其他 Skill。
- 如果用户后续明确要求“保存副单位/以后都按这个算”，不要在本 Skill 中调用未授权工具或用规则兜底。本 Skill 只能说明需要进入食材档案流程；由 Orchestrator 注入 `ingredient_profile` 后，读取真实食材信息并通过 `ingredient_profile.create_draft` 生成单独审批。
- 用户只说“怎么处理”但没有明确消耗、销毁或补货时，应先追问处理目标，不要擅自生成写操作草稿。
- 数量、单位或处理目标不明确，且不是上述单位换算兼容流程时，调用 `human.request_input`，并提供候选批次摘要。
- 草稿中的每项必须引用工具返回的真实 `ingredientId`；消耗可以省略 `inventoryItemId` 让后端按默认扣减顺序处理，也可在用户明确指定批次时填写真实 `inventoryItemId`；销毁必须指定真实 `inventoryItemId`。
- 不存在的食材不能自行创建，明确提示用户先建立食材档案。
- 销毁必须说明原因；用户没有指定数量时，默认销毁所选批次全部剩余量。
- 可以在一个草稿中混合多项操作。只有用户确认后后端才会正式写入库存。
- 调用 `inventory.create_operation_draft` 时，`draft` 必须是完整草稿对象，至少包含：

  ```json
  {
    "draftType": "inventory_operation",
    "schemaVersion": "inventory_operation.v1",
    "operations": [
      {
        "action": "consume",
        "ingredientId": "ingredient_xxx",
        "quantity": 1,
        "unit": "个"
      }
    ]
  }
  ```

- 不要只提交 `draftType` / `schemaVersion` 的空壳，也不要省略 `draftType`。
