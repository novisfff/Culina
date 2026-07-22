---
name: inventory-analysis
description: 查询家庭库存概览、可用库存、临期、过期和低库存；库存查询包含食材库存以及成品/速食食物库存；统一入库、消耗和销毁通过确认草稿处理。
---

# 库存分析 Skill

## 用户目标

- 查询家庭库存概览、可用库存、临期、过期和低库存。
- 对已有食材执行消耗和销毁的可确认草稿。
- 所有库存增加（小票、采购文本、冰箱照片、赠送、盘点、额外购买、买到了）统一进入一份 `inventory_intake` 正式草稿；部分采购（如“实际只买了 1 盒，剩下继续待买”）也走本 Skill，不得回落到购物清单草稿。
- 库存查询同时覆盖食材 `InventoryItem` 与成品/速食 Food 的 `stock_quantity`、`stock_unit`、`expiry_date`；低库存只覆盖食材。

## 不适用范围

- 不制定餐食计划、不回答“今天吃什么”，也不创建购物清单。
- 成品、速食、包装食品的资料创建/字段更新属于 `food_profile`；已有 ready-like Food 的直接入库仍由本 Skill 负责。
- 食材定义、默认单位、支持单位、保质期和低库存阈值属于 `ingredient_profile`。
- Food 库存不能当作菜谱原料，也不能替代真实 Ingredient ID。
- 不输出入库候选卡，不调用任何 preview intake Tool，也不新增 intake 专用 resolver Tool。
- 入库不得通过 `inventory_operation.restock` 或任何 shopping intake 草稿完成。

## 工作模式

- `query`：按问题选择最小读取工具。“有什么库存”读可用库存，“快过期”读临期，“已过期”读过期，“需要补货”读低库存，泛化概览才读 summary；通过工具返回 `inventory_summary` 卡片，不自造卡片。
- `restock` / 统一入库：按九步合同解析来源行，解决全部 blocker 后调用一次 `inventory.create_intake_draft`。
- `consume`：可省略 `inventoryItemId`，由后端按到期日、采购日和创建时间扣减；用户指定批次时必须使用真实批次 ID。
- `dispose`：必须绑定真实 `inventoryItemId` 并说明原因；未给数量时默认所选批次全部剩余量。
- 消耗/销毁的 `operations[].action` 只能是 `consume`、`dispose`；库存增加一律使用 `inventory_intake`，不再用 `inventory_operation.restock` 处理新入库。

统一入库九步合同（Skill 拥有编排，不依赖场景专用 resolver Tool）：

1. 从文本/图片/小票提取 1–30 条来源行，形成稳定工作证据，键为 `sourceLineId`。超过 30 行时，先用 `human.request_input` 请用户缩小批次或选择最多 30 行；不要故意触发 Tool schema 失败来控制流程。
2. 明确采购/小票语义时，先调用一次 `shopping.read_pending(status=pending)`；赠送/非采购语义时，不得自动使用同名 pending 行。
3. 每一条提取行——包括模型怀疑是非库存对象的行——都进入同一次批量 `purchasable.resolve_candidates`，使用稳定 `clientKey=sourceLineId`。
4. 用真实 `ingredientId`/`foodId` 把 exact 候选与 pending 购物项关联；名称只用于揭示歧义，不得覆盖冲突的目标 ID。
5. 只有 `status=exact` 可自动绑定。`candidate`/`ambiguous` 必须 `human.request_input`；`missing` 必须资料 handoff、明确非食品忽略，或 skip。
6. 唯一 exact 目标且没有适用 pending 时，默认 `sourceKind=direct, action=stock_only`。额外购买永不创建 ShoppingListItem。
7. 仅当批量候选/pending 输出缺少决策所需细节时，才调用 `ingredient.read_by_id`、`food.read_by_id` 或 `shopping.read_by_id`。Draft 规范化仍是版本号与 before 快照的最终来源。
8. 比较录入单位与候选 `defaultUnit/supportedUnits` 或 Food `stockUnit`。不支持单位走现有 `human.request_input`；选择一次性换算后必须再问一次正数目标数量。
9. 全部行解决后，调用一次 `inventory.create_intake_draft`，提交可执行/skip 行和只读忽略行。绝不渲染候选卡，也不发明第二次确认步骤。

## 前置条件

- 所有名称、数量、单位、状态和到期日期来自当前家庭工具结果，不编造阈值、日期或业务 ID。
- 用户明确写操作时先读取真实食材/食物或库存；统一入库必须有真实目标或已解决的 ignore/skip 决策，`dispose` 必须有真实批次，`consume` 必须有真实食材。
- `unit` 优先使用 `supportedUnits` 或 Food `stockUnit`。不支持的单位先澄清一次性换算，不能调用普通库存草稿试错。
- 单位换算追问使用 `resumeHint.questionType=inventory_intake_resolution` 或 `unit_conversion`，并在 `resumeHint.state` 中携带完整 `InventoryIntakeContinuationState`（见下方 typed continuation 规则）。
- `itemKind=non_inventory` 只是模型证据，从不绕过 `purchasable.resolve_candidates`。出现 exact Ingredient/Food 候选时，不得静默忽略该行。
- 明确赠送/非采购输入一律直接入库，即使存在同名 pending 项。
- 来源未知且存在合理 pending 项时，请求用户选择“关联采购清单”还是“直接入库”。
- exact Ingredient/Food 的入库动作若缺少可靠数量，必须在创建 Draft 前补齐。
- 日期优先级：用户明确日期 > 小票日期 > 家庭业务日；冲突时通过 `human.request_input` 询问。
- `convert_once`、`fulfill_without_stock`、`skip` 必须在每次暂停后保留，避免重复提问。
- 忽略行是只读说明，不是待确认项；用户文案必须区分“采购清单关联”“直接入库”“已忽略”。
- 任一 blocker（候选歧义、单位不匹配、数量缺失、日期冲突、来源歧义等）都通过 `human.request_input` 一次只问一个问题，按原始 `sourceOrder` 顺序推进。
- `resumeHint` 必须携带完整校验过的 continuation state，而不是只带当前行；`questionType=inventory_intake_resolution`，`state` 为完整 `InventoryIntakeContinuationState`。
- state 保留来源/日期证据、全部原始行、已确认目标/动作/数量/单位/packageConversion/ignore/skip，以及 current/pending blockers。
- 不得把 row version、before 快照或已生成 Draft 放进 continuation state。
- 恢复时只应用当前用户回答，从下一个未解决 blocker 继续既有 Tool 编排；创建 Draft 前按需重读所选购物项/Ingredient/Food。

## 候选处理

- Ingredient/Food 缺失时不自行创建；说明缺口并进入对应 profile handoff。
- 目标不唯一、库存不足、指定批次无法对应或数量/单位/动作不明确时，调用 `human.request_input` 并提供真实候选摘要。
- 用户给出“1 不支持单位 = N 主单位”后，在统一入库行上通过 `packageConversion` 表达一次性换算；不得把一次性换算自动保存为副单位，也不得为 intake 调用 `inventory.create_unit_conversion_operation_draft` 或 `inventory_operation.restock`。
- 用户明显换话题时不强行恢复旧换算；按当前消息处理或交回 Orchestrator。
- `purchasable.resolve_candidates` 结果不是候选卡，也不是用户确认；只有全部原始行解决后才可创建 `inventory_intake` 草稿。

## Handoff

- `missing_ingredient`：目标 Ingredient 不存在且属于旧式单项库存操作时，typed `continuation` 指向 `ingredient_profile`，草稿类型 `ingredient_profile`，审批后恢复 `inventory_analysis`，state 使用 `inventory_missing_ingredient.v1`。
- `missing_intake_target` / `missing_intake_food_target`：统一入库过程中缺失 Ingredient 或 ready-like Food 时，state 使用 `inventory_intake_missing_target.v1`；profile 只创建缺失资料草稿，审批成功后恢复本 Skill 继续入库编排。
- 图片或小票包含多个缺失目标时，每次只补建一个；审批成功后恢复统一入库编排，不能直接入库。
- 缺失目标 handoff 时完整保留 `inventory_intake_missing_target.v1`；profile 审批成功后只恢复 `inventory_analysis`，替换 `currentMissingSourceLineId` 对应的新目标，再重读当前实体后继续入库，不自动生成 Draft。
- `save_unit_conversion`：用户明确要求“保存副单位/以后都按这个算”时，typed `continuation` 指向 `ingredient_profile`，state 使用 `inventory_unit_conversion.v1`；保存审批成功后恢复库存任务。
- 对保存副单位请求，本 Skill 只能说明需要进入食材档案流程，并通过声明的 handoff 交给 `ingredient_profile`，不能调用未授权工具。
- continuation state 只保存证据与用户确认决策，不复制完整库存草稿；目标审批成功后只恢复 Skill，不自动生成或提交下一草稿。

## 审批规则

- 统一入库只通过 `inventory.create_intake_draft` 生成 `inventory_intake.v1`。
- 普通食材消耗/销毁只通过 `inventory.create_operation_draft`；库存增加不得再走 `inventory_operation.restock`。
- 草稿必须是完整对象，不提交空壳。
- 最小完整 `inventory_operation` 结构示例：

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
- 可以在一个草稿中混合多项明确操作；遵循 `draft -> approval -> commit`，只有确认后后端正式写库存。
- 所有可执行入库行都在同一份 `inventory_intake` 审批中确认；不存在候选卡二次发起。

## 用户反馈

- 纯查询直接解释工具卡片中的重点，不创建草稿，也不改写卡片项目。
- 生成写操作草稿前说明动作、对象、数量、单位及来源（采购清单关联 / 直接入库 / 已忽略）。
- 单位不支持时说明本次换算不会自动保存；用户要求保存时说明将先确认 Ingredient 档案更新，再恢复库存操作。
- 忽略行说明原因，不说“还需确认”。
