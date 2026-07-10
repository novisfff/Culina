# 餐食计划 Workflow

## 即时推荐

1. 确认用户没有要求日期范围、连续多天或正式计划。
2. 读取可用库存、临期食材和最近餐食。
3. 按需查询当前家庭食物和菜谱。
4. 选择 1–3 个真实候选并说明推荐理由和依据；每个候选必须有真实 `foodId` 或 `recipeId`，展示字段交给 `meal_plan.recommend_today` 补齐。
5. 调用 `meal_plan.recommend_today` 返回 `today_recommendation` 卡片，不创建草稿。

## 创建正式计划

1. 读取库存、临期食材、最近餐食、食物和菜谱。
2. 确认天数、日期、餐别和约束；关键范围缺失时追问。
3. 把餐别映射为 `breakfast`、`lunch`、`dinner` 或 `snack`；不要使用自由餐别值。
4. “安排/作为今天晚餐/放到今晚菜单”创建的是 `FoodPlanItem` 餐食计划，不是用餐记录；只有用户明确说“吃了/已吃/记录”才把 `meal_log` 作为计划确认后的后续步骤。
5. 使用真实 `foodId` 和匹配的 `recipeId` 生成完整计划；如果食物不在食物库中，停止当前计划草稿，并按 `missing_food` handoff 创建指向 `food_profile` 的 typed `continuation`。Food 审批成功后只恢复 `meal_plan`，再基于真实 Food 生成计划草稿。
6. 如果用户同时要求“安排并记录/已吃”，保留原始完整目标；计划确认后由 Orchestrator 根据审批 artifact 再注入 `meal_log`，用餐记录尽量关联真实 `planItemId`。不要在计划草稿里携带自由格式后续指令，也不要自动生成下一草稿。
7. 缺失食材提醒中有真实食材匹配时绑定 `ingredientId`；没有匹配时只保留名称和数量，不假装已创建食材档案。
8. 调用 `meal_plan.create_draft`。
9. 返回待确认草稿。

## 修改已有计划

1. 优先通过 `meal_plan.read_existing` 或 `meal_plan.read_by_id` 定位真实计划项。
2. 修改、删除或状态变更正式计划时，生成 `operations` 草稿；每项必须带真实 `targetId`、`baseUpdatedAt` 和可编辑 payload。
3. 状态变更只能使用 `planned`、`cooked`、`skipped`；不要输出中文状态或自定义状态值。
4. 用户修改当前运行中的 `meal_plan` 草稿时，先读取完整 artifact 后生成新的完整草稿版本，不能把 `in_run:*` 草稿 ID 当作正式计划 ID。
5. 调用 `meal_plan.create_draft` 返回待确认草稿。
