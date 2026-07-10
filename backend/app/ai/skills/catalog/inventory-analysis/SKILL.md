---
name: inventory-analysis
description: 查询家庭库存概览、可用库存、临期、过期和低库存；库存查询包含食材库存以及成品/速食食物库存；食材入库、消耗和销毁通过确认草稿处理。
---

# 库存分析 Skill

## 用户目标

- 查询家庭库存概览、可用库存、临期、过期和低库存。
- 对已有食材执行入库、消耗和销毁的可确认草稿。
- 库存查询同时覆盖食材 `InventoryItem` 与成品/速食 Food 的 `stock_quantity`、`stock_unit`、`expiry_date`；低库存只覆盖食材。

## 不适用范围

- 不制定餐食计划、不回答“今天吃什么”，也不创建购物清单。
- 成品、速食、包装食品的库存字段更新属于 `food_profile`，不能调用食材库存草稿。
- 食材定义、默认单位、支持单位、保质期和低库存阈值属于 `ingredient_profile`。
- Food 库存不能当作菜谱原料，也不能替代真实 Ingredient ID。

## 工作模式

- `query`：按问题选择最小读取工具。“有什么库存”读可用库存，“快过期”读临期，“已过期”读过期，“需要补货”读低库存，泛化概览才读 summary；通过工具返回 `inventory_summary` 卡片，不自造卡片。
- `restock`：先确认真实 Ingredient、`defaultUnit`、`supportedUnits` 和换算关系，再生成入库草稿。
- `consume`：可省略 `inventoryItemId`，由后端按到期日、采购日和创建时间扣减；用户指定批次时必须使用真实批次 ID。
- `dispose`：必须绑定真实 `inventoryItemId` 并说明原因；未给数量时默认所选批次全部剩余量。
- `operations[].action` 只能是 `restock`、`consume`、`dispose`；入库 `status` 只能是 `fresh`、`opened`、`frozen`、`expiring`。

## 前置条件

- 所有名称、数量、单位、状态和到期日期来自当前家庭工具结果，不编造阈值、日期或业务 ID。
- 用户明确写操作时先读取真实食材或库存；`restock` 必须有真实 `ingredientId`，`dispose` 必须有真实批次，`consume` 必须有真实食材。
- `unit` 优先使用 `supportedUnits`。不支持的单位先澄清一次性换算，不能调用普通库存草稿试错。
- 单位换算追问使用 `resumeHint.questionType=unit_conversion`，并保存 `ingredientId`、`ingredientName`、`defaultUnit`、`unsupportedUnit`、`supportedUnits` 和 `originalDraft`。

## 候选处理

- Ingredient 缺失时不自行创建；说明缺口并进入 `missing_ingredient` handoff。
- 目标不唯一、库存不足、指定批次无法对应或数量/单位/动作不明确时，调用 `human.request_input` 并提供真实候选摘要。
- 用户给出“1 不支持单位 = N 主单位”后，调用 `inventory.create_unit_conversion_operation_draft`，只按本次换算入库，不保存为副单位。
- 用户明显换话题时不强行恢复旧换算；按当前消息处理或交回 Orchestrator。

## Handoff

- `missing_ingredient`：目标 Ingredient 不存在时，typed `continuation` 指向 `ingredient_profile`，草稿类型 `ingredient_profile`，审批后恢复 `inventory_analysis`，state 使用 `inventory_missing_ingredient.v1`。
- `save_unit_conversion`：用户明确要求“保存副单位/以后都按这个算”时，typed `continuation` 指向 `ingredient_profile`，state 使用 `inventory_unit_conversion.v1`；保存审批成功后恢复库存任务。
- 对保存副单位请求，本 Skill 只能说明需要进入食材档案流程，并通过声明的 handoff 交给 `ingredient_profile`，不能调用未授权工具。
- `ready_food_stock`：用户要修改成品、速食或包装食品库存字段时，typed `continuation` 指向并恢复 `food_profile`，state 使用 `ready_food_stock.v1`。
- continuation state 只保存名称、动作、换算参数和简短 instruction，不复制完整库存草稿；目标审批成功后只恢复 Skill，不自动生成或提交下一草稿。

## 审批规则

- 普通食材库存操作只通过 `inventory.create_operation_draft`；一次性单位换算入库只通过 `inventory.create_unit_conversion_operation_draft`。
- 草稿必须是包含 `draftType=inventory_operation` 和非空 `operations` 的完整对象，不提交空壳。
- 最小完整结构示例：

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

## 用户反馈

- 纯查询直接解释工具卡片中的重点，不创建草稿，也不改写卡片项目。
- 生成写操作草稿前说明动作、对象、数量、单位及批次选择方式。
- 单位不支持时说明本次换算不会自动保存；用户要求保存时说明将先确认 Ingredient 档案更新，再恢复库存操作。
