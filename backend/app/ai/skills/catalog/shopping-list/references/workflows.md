# 购物清单 Workflow

## 独立创建

1. 读取待采购项和可用库存。
2. 根据用户明确需求整理采购项。
3. 对具体食材名称调用 `ingredient.search` / `ingredient.read_by_id`，能明确匹配时绑定真实 `ingredientId`；不能匹配时只保留采购 `title`，不要创建或伪造食材档案。
4. 合并同名同单位项目并排除已有库存；已有待买项相似时优先生成 `update` 或追问是否合并。
5. `quantityMode` 只能是 `track_quantity` 或 `not_track_quantity`，单位优先使用食材默认单位、支持单位或前端购物常用单位。
6. 调用 `shopping.create_draft`。

## 从餐食计划派生

1. 从 `current_run_artifacts` 中优先找到真实 `meal_plan` 草稿；如果没有，再使用同一会话中已持久化且可读取的 `meal_plan` 草稿。
2. 需要完整计划或购物草稿时先调用 `workspace.read_artifact`，不要根据摘要补全采购项。
3. 提取缺失食材并扣除已有库存；已有 `ingredientId` 时绑定真实食材，没有 ID 时只作为采购名称。
4. 结合 `shopping.read_pending` 合并重复项目并记录来源餐食，避免重复加入待采购项。
5. 使用真实 `sourceDraftId` 调用 `shopping.create_draft`。`sourceDraftId` 只能是当前运行 artifact 的 `in_run:*` ID，或同一会话中真实存在的持久草稿 ID。

## 修改购物清单

1. 优先通过 `shopping.read_pending` 或 `shopping.read_by_id` 定位真实购物项。
2. 修改、标记买到、恢复待买或删除正式购物项时，生成 `operations` 草稿；每项必须带真实 `targetId`、`baseUpdatedAt` 和可编辑 payload。
3. `set_done.payload.done` 只能是布尔值：买到为 `true`，恢复待买为 `false`。
4. 用户修改当前运行中的 `shopping_list` 草稿时，可以基于 artifact 生成新的完整草稿版本，但不能把 `in_run:*` 草稿 ID 当作正式购物项 ID。
5. 调用 `shopping.create_draft` 返回待确认草稿。
