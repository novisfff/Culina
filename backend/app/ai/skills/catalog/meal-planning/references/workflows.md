# 餐食计划 Workflow

## 即时推荐

1. 确认用户没有要求日期范围、连续多天或正式计划。
2. 读取可用库存、临期食材和最近餐食。
3. 按需查询当前家庭食物和菜谱。
4. 选择 1–3 个真实候选并说明推荐理由和依据。
5. 调用 `meal_plan.recommend_today` 返回 `today_recommendation` 卡片，不创建草稿。

## 创建正式计划

1. 读取库存、临期食材、最近餐食、食物和菜谱。
2. 确认天数、日期、餐别和约束；关键范围缺失时追问。
3. 使用真实 `foodId` 和匹配的 `recipeId` 生成完整计划；如果食物不在食物库中，停止当前计划草稿并提示先进入食物资料流程。
4. 调用 `meal_plan.create_draft`。
5. 返回待确认草稿。

## 修改已有计划

1. 优先通过 `meal_plan.read_existing` 或 `meal_plan.read_by_id` 定位真实计划项。
2. 修改、删除或状态变更正式计划时，生成 `operations` 草稿；每项必须带真实 `targetId`、`baseUpdatedAt` 和可编辑 payload。
3. 用户修改当前运行中的 `meal_plan` 草稿时，可以基于 artifact 生成新的完整草稿版本，但不能把 `in_run:*` 草稿 ID 当作正式计划 ID。
4. 调用 `meal_plan.create_draft` 返回待确认草稿。
