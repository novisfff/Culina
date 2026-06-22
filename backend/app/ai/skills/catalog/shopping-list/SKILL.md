---
name: shopping-list
description: 创建、修改、删除或标记购物清单项，可根据餐食计划草稿、库存缺口和已有待买项派生采购建议；不处理库存入库、不创建食材档案、不制定餐食计划。
---

# 购物清单 Skill

## 自主决策空间

- 可以根据用户原话、计划 artifact、待采购项和库存，自主选择读取购物、库存或食材工具，不需要固定顺序。
- 采购项的原因、来源餐食和可编辑备注可以合理补全；名称、数量、单位会影响采购结果时必须明确。
- 用户提到具体食材、单位或别名时，必须使用 `ingredient.search` / `ingredient.read_by_id` 确认当前家庭真实食材、默认单位和支持单位，再整理采购项。
- 从计划、库存和待买项派生采购建议时，先读取可用库存和待买项，由模型根据真实工具结果整理候选；不要依赖脚本做后置归一化或重复项修正。
- 目标唯一且工具结果明确时不要重复追问；多个近似待买项、多个食材候选或购物状态变更目标不明确时再请求澄清。

## 执行规则

- 创建前读取待采购项和可用库存。
- 涉及具体食材名称、单位或常见别名时，优先查询真实食材资料；没有匹配食材时可以保留用户原名称作为可编辑采购项，不要编造食材 ID。
- 从计划派生时必须引用真实 `meal_plan` artifact，优先使用当前运行 `current_run_artifacts` 中的 `in_run:*` 草稿，其次使用同一会话中已持久化且可读取的 `AITaskDraft`。
- 修改和删除必须先读取真实购物项，并生成带 `action`、`targetId` 和 `baseUpdatedAt` 的操作草稿。
- 用户没有说明操作数量、存在多个近似待买项或需要确认是否标记买到时，调用 `human.request_input`，并附上候选摘要。
- `sourceDraftId` 只能来自当前运行 artifact 的 `in_run:*` ID，或同一会话中真实存在的 `meal_plan`/`shopping_list` 草稿 ID；不能从用户文字、历史摘要或模型记忆中编造。
- 从 meal_plan artifact 或计划缺料生成采购项时，结合 `shopping.read_pending` 和 `inventory.read_available_items` 的真实结果整理候选；已有库存或待买项覆盖时，不要生成重复采购草稿。
- 扣除已有库存，并避免重复加入待采购项。
- 仅通过 `shopping.create_draft` 生成 `shopping_list` 草稿。
- 修改、完成和恢复待买都必须生成带 `action`、`targetId` 和 `baseUpdatedAt` 的操作草稿。
- 购物状态变更使用 `set_done`，`done=true` 表示买到，`done=false` 表示恢复待买。
- 用户确认前不得写入正式 `ShoppingListItem`；确认后由后端根据操作类型执行 create、update 或 delete。
