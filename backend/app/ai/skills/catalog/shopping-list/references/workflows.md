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
2. 修改、恢复待买或删除正式购物项时，生成 `operations` 草稿；每项必须带真实 `targetId`、`baseUpdatedAt` 和可编辑 payload；create/update payload 必须绑定真实 `ingredientId` 或 ready-like 食物 `foodId`。
3. 普通草稿只允许 `set_done.payload.done=false` 恢复待买；新的“买到”请求进入下面的一体化采购流程。
4. 用户修改当前运行中的 `shopping_list` 草稿时，可以基于 artifact 生成新的完整草稿版本，但不能把 `in_run:*` 草稿 ID 当作正式购物项 ID。
5. 调用 `shopping.create_draft` 返回待确认草稿。

## 购物完成与一体化入库

1. 根据小票、当前卡片/artifact 或用户明确列名确定范围；裸“这些都买到了”先读取 pending 项并请求多选，不能默认全选家庭清单。
2. 把识别行交给 `shopping.preview_intake_candidates`。confirmed/suggested 可以进入草稿；ambiguous 先选择；unmatched 只放入额外购买候选并给建档、选目标或后续单独入库建议。
3. 实际数量没有可靠证据时保持为空；不得用计划数量代替。一次性包装换算必须保留倍率、目标单位和证据。
4. 用 `shopping.create_intake_draft` 生成单项或批量 `shopping_intake` 草稿。每行选择完成并入库或仅完成购物项。
5. 用户只确认一份审批；执行时复用原子 shopping intake service，同时更新购物状态、库存和操作历史。任一行失败整批回滚。
6. 部署前已存在的 `shopping_to_stock.v1` continuation 仍可完成，但新请求不再生成两阶段流程。
