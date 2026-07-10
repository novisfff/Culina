# 购物清单 Workflow

## 独立创建

1. 读取待采购项和可用库存。
2. 根据用户明确需求整理采购项，并优先调用 `purchasable.resolve_candidates` 批量解析原材料与成品、速食、包装食品。
3. `exact` 才能直接绑定；`candidate` / `ambiguous` 必须结合真实元数据确认或让用户选择。Ingredient 绑定真实 `ingredientId`，只有 `readyMade` / `instant` / `packaged` Food 可以绑定真实 `foodId`。
4. 如果存在缺失档案，原材料按 `missing_ingredient` typed handoff 逐项进入 `ingredient_profile`，ready-like Food 按 `missing_ready_food` handoff 逐项进入 `food_profile`；每次 profile 审批成功后只恢复 `shopping_list`，不自动生成采购草稿。
5. 合并同名同单位项目并排除已有库存；已有待买项相似时优先生成 `update` 或追问是否合并。
6. `quantityMode` 只能是 `track_quantity` 或 `not_track_quantity`，单位优先使用食材默认单位、支持单位或前端购物常用单位。
7. 每个采购项都有真实 `ingredientId` 或 ready-like 食物 `foodId` 后，调用 `shopping.create_draft`。

## 从餐食计划派生

1. 从 `current_run_artifacts` 中优先找到真实 `meal_plan` 草稿；如果没有，再使用同一会话中已持久化且可读取的 `meal_plan` 草稿。
2. 需要完整计划或购物草稿时先调用 `workspace.read_artifact`，不要根据摘要补全采购项。
3. 提取缺失食材并扣除已有库存；已有真实 `ingredientId` 时绑定，没有 ID 时按 typed handoff 逐项补食材档案，不得只作为采购名称。
4. 结合 `shopping.read_pending` 合并重复项目并记录来源餐食，避免重复加入待采购项。
5. 每个采购项都有真实 `ingredientId` 或 ready-like 食物 `foodId` 后，使用真实 `sourceDraftId` 调用 `shopping.create_draft`。`sourceDraftId` 只能是当前运行 artifact 的 `in_run:*` ID，或同一会话中真实存在的持久草稿 ID。

## 修改购物清单

1. 优先通过 `shopping.read_pending` 或 `shopping.read_by_id` 定位真实购物项。
2. 修改、标记买到、恢复待买或删除正式购物项时，生成 `operations` 草稿；每项必须带真实 `targetId`、`baseUpdatedAt` 和可编辑 payload；create/update payload 必须绑定真实 `ingredientId` 或 ready-like 食物 `foodId`。
3. `set_done.payload.done` 只能是布尔值：买到为 `true`，恢复待买为 `false`。
4. 用户修改当前运行中的 `shopping_list` 草稿时，可以基于 artifact 生成新的完整草稿版本，但不能把 `in_run:*` 草稿 ID 当作正式购物项 ID。
5. 调用 `shopping.create_draft` 返回待确认草稿。

## 购物完成后的入库

1. 仅当一份购物草稿中恰好一个 `set_done.payload.done=true` 操作审批并提交成功时，接收后端基于已提交购物项生成的 `shopping_to_stock.v1` continuation；拒绝、恢复待买、更新、删除和批量完成都不进入本流程。
2. Ingredient 分支按 continuation 的精确 `ingredientId` 调用 `ingredient.read_by_id`；ready-like Food 分支按精确 `foodId` 调用 `food.read_by_id`。不得重新搜索并替换目标，也不得使用其他家庭实体。
3. 向用户展示本次购物数量和单位。Ingredient 生成第二份 `inventory_operation` restock 草稿；Food 用当前库存数量加本次采购数量，生成第二份 `food_profile` 更新草稿。
4. 第二份草稿必须再次确认后才写库存；二次审批前只说明购物项已完成、入库待确认，不得声称库存已经增加。
