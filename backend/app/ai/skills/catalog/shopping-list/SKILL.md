---
name: shopping-list
description: 创建、修改、删除或标记购物清单项，可根据餐食计划草稿、库存缺口和已有待买项派生采购建议；不处理库存入库、不创建食材档案、不制定餐食计划。
---

# 购物清单 Skill

## 自主决策空间

- 可以根据用户原话、计划 artifact、待采购项和库存，自主选择读取购物、库存或食材工具，不需要固定顺序。
- 采购项的原因、来源餐食和可编辑备注可以合理补全；名称、数量、单位会影响采购结果时必须明确。
- 用户提到具体原材料、单位或别名时，必须使用 `ingredient.search` / `ingredient.read_by_id` 确认当前家庭真实食材、默认单位和支持单位，再整理采购项。
- 用户明确要买成品、速食或包装食品时，优先匹配当前家庭真实食物档案，并只允许 `readyMade` / `instant` / `packaged` 进入采购清单。
- 创建采购清单前，每个采购项都必须绑定当前家庭真实采购对象 ID：食材用 `ingredientId`，成品速食/包装食品用 `foodId`；搜索只是候选召回，不能把检索结果自动当作匹配成功。
- 从计划、库存和待买项派生采购建议时，先读取可用库存和待买项，由模型根据真实工具结果整理候选；不要依赖脚本做后置归一化或重复项修正。
- 目标唯一且工具结果明确时不要重复追问；多个近似待买项、多个食材候选或购物状态变更目标不明确时再请求澄清。

## 字段取值规则

- `quantityMode` / `quantity_mode` 只能是 `track_quantity` 或 `not_track_quantity`；用户只想提醒“买点香菜”时用 `not_track_quantity` 和展示文案，不硬填精确数量。
- 单位优先用食材默认单位、食材支持单位或前端购物常用单位：`个`、`颗`、`盒`、`袋`、`斤`、`克`、`瓶`、`把`、`份`、`片`。只有用户明确给出其他真实单位时才自定义。
- `set_done.payload.done` 只能是布尔值；“买到了/完成/已买”映射为 `true`，“恢复待买/还没买/撤销完成”映射为 `false`。
- 用户明确要买某个原材料且 `ingredient.search` 有明确同一食材候选时，采购项必须绑定真实 `ingredientId`；明确要买成品速食且已有对应食物档案时，绑定真实 `foodId`；无匹配时不要调用 `shopping.create_draft`。
- 从 meal_plan artifact 派生时，缺失食材已有真实 `ingredientId` 就绑定；没有 ID 时必须先引导创建食材档案，不能只作为采购名称写入清单。

## 执行规则

- 创建前读取待采购项和可用库存。
- 涉及具体原材料名称、单位或常见别名时，优先查询真实食材资料；涉及成品、速食、包装食品时，优先匹配真实食物资料。没有匹配档案时不要编造 ID，也不要保留自由采购项。
- 发现一个或多个采购项缺少真实食材档案时，先走 `ingredient_profile` 草稿；缺少成品速食食物档案时，先走 `food_profile` 草稿。用户确认档案后再继续生成采购清单草稿。
- 从计划派生时必须引用真实 `meal_plan` artifact，优先使用当前运行 `current_run_artifacts` 中的 `in_run:*` 草稿，其次使用同一会话中已持久化且可读取的 `AITaskDraft`。
- 历史 artifact 默认只提供摘要和 ID；需要读取计划或购物草稿的完整 `items` 时，先调用 `workspace.read_artifact`，不要根据摘要补全采购项。
- 修改和删除必须先读取真实购物项，并生成带 `action`、`targetId` 和 `baseUpdatedAt` 的操作草稿。
- 用户没有说明操作数量、存在多个近似待买项或需要确认是否标记买到时，调用 `human.request_input`，并附上候选摘要。
- `sourceDraftId` 只能来自当前运行 artifact 的 `in_run:*` ID，或同一会话中真实存在的 `meal_plan`/`shopping_list` 草稿 ID；不能从用户文字、历史摘要或模型记忆中编造。
- 从 meal_plan artifact 或计划缺料生成采购项时，结合 `shopping.read_pending` 和 `inventory.read_available_items` 的真实结果整理候选；已有库存或待买项覆盖时，不要生成重复采购草稿；缺料没有真实 `ingredientId` 时先走食材档案流程。
- 扣除已有库存，并避免重复加入待采购项。
- 已有待买项与新需求相似时，优先生成 `update` 操作或调用 `human.request_input` 询问是否合并；不要直接重复创建同名同单位采购项。
- 仅通过 `shopping.create_draft` 生成 `shopping_list` 草稿，且每个 create/update payload 必须带真实 `ingredientId` 或 ready-like 食物的真实 `foodId`，不能同时带两者。
- 修改、完成和恢复待买都必须生成带 `action`、`targetId` 和 `baseUpdatedAt` 的操作草稿。
- 购物状态变更使用 `set_done`，`done=true` 表示买到，`done=false` 表示恢复待买。
- 用户确认前不得写入正式 `ShoppingListItem`；确认后由后端根据操作类型执行 create、update 或 delete。
