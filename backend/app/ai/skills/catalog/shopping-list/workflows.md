# 购物清单 Workflow

## 独立创建

1. 读取待采购项和可用库存。
2. 根据用户明确需求整理采购项。
3. 合并同名同单位项目并排除已有库存。
4. 调用 `shopping.create_draft`。

## 从餐食计划派生

1. 从 `current_run_artifacts` 中优先找到真实 `meal_plan` 草稿；如果没有，再使用同一会话中已持久化且可读取的 `meal_plan` 草稿。
2. 提取缺失食材并扣除已有库存。
3. 合并重复项目并记录来源餐食。
4. 使用真实 `sourceDraftId` 调用 `shopping.create_draft`。`sourceDraftId` 只能是当前运行 artifact 的 `in_run:*` ID，或同一会话中真实存在的持久草稿 ID。

## 修改购物清单

1. 优先通过 `shopping.read_pending` 或 `shopping.read_by_id` 定位真实购物项。
2. 修改、标记买到、恢复待买或删除正式购物项时，生成 `operations` 草稿；每项必须带真实 `targetId`、`baseUpdatedAt` 和可编辑 payload。
3. 用户修改当前运行中的 `shopping_list` 草稿时，可以基于 artifact 生成新的完整草稿版本，但不能把 `in_run:*` 草稿 ID 当作正式购物项 ID。
4. 调用 `shopping.create_draft` 返回待确认草稿。
