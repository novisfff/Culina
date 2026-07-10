---
name: meal-record
description: 记录或修改已经发生的早餐、午餐、晚餐和加餐，包括补充备注、照片、心情和评分；不安排未来餐食计划、不执行菜谱做菜扣库存、不创建食物资料。
---

# 餐食记录 Skill

## 用户目标

- 查询、创建或更新已经发生的早餐、午餐、晚餐和加餐记录。
- 补充备注、照片、心情、参与人或评分，并尽量关联真实餐食计划项。

## 不适用范围

- 未来安排交给 `meal_plan`；按菜谱做菜并扣库存交给 `recipe_cook`；Food 资料创建和更新交给 `food_profile`。
- “安排为今天晚餐/放到今晚菜单”没有“吃了/已吃/记录”语义时，不创建 MealLog。
- 当前不支持删除餐食记录。

## 工作模式

- `query`：使用 `meal_log.read_recent` 或 `meal_log.read_by_id` 查询真实记录，只摘要不生成草稿。
- `create`：食物、日期和餐别明确后生成新记录；`foods[].servings` 必须大于 0，未说明时默认 1 份。
- `update`：补充详情使用 `update_details`，评分使用 `rate_food`；先读取真实记录并定位评分对象。
- `mealType` 只能是 `breakfast`、`lunch`、`dinner`、`snack`；评分只能在 0.5 到 5 之间，没有明确评分时留空。
- `mood` 使用适合展示的短词，不输出长句或营养诊断式评价。

## 前置条件

- 调用 `food.search` 匹配当前家庭真实 Food；`foods[].foodId` 必须来自工具结果，名称与 ID 对应。
- `participantUserIds`、`planItemId` 只来自真实上下文或工具结果，不从文字和历史摘要推断。
- 当前消息图片只有在用户明确要求作为本次用餐记录照片时，才把 `currentAttachments` 中真实 `mediaId` 写入 `mediaIds`；不得引用历史或跨家庭媒体。
- 历史记录更新必须先读取详情；需要完整历史 artifact 时调用 `workspace.read_artifact`。

## 候选处理

- `food.search` 只做候选召回。Food 不存在时不得提交自由名称，进入 `missing_food` handoff。
- 多个相似 Food、日期餐别不清、多条相似记录或评分对象不唯一时，调用 `human.request_input` 并展示候选摘要。
- 图片只是上下文、归属不明或用户未表达绑定意图时，不传 `mediaIds`。
- 需要参与人或计划关联但没有真实 ID 时，让用户在审批表单核对或补充，不编造 ID。

## Handoff

- `missing_food`：已发生用餐中的 Food 不存在时，typed `continuation` 指向 `food_profile`，`requiredDraftType=food_profile`，审批后恢复 `meal_log`，state 使用 `meal_missing_food.v1`。
- continuation state 只保存 Food 名称、日期、餐别和简短 instruction，不复制完整 MealLog 草稿。
- 用户目标是“安排并记录”时顺序固定为真实 Food -> 餐食计划审批 -> MealLog 草稿；本 Skill 只在前置实体和计划结果真实可用后执行。

## 审批规则

- 创建、补充详情和评分只通过 `meal_log.create_draft`，遵循 `draft -> approval -> commit`。
- 确认前不得写正式 MealLog；Food 缺失或关键 ID 不真实时不得生成无效草稿。
- continuation 审批成功后只恢复本 Skill，不自动生成或提交 MealLog 草稿。

## 用户反馈

- 草稿前说明记录的日期、餐别、Food、份数以及会绑定的当前消息图片。
- Food 缺失时说明先确认 Food 资料，再继续记录；不声称已记录成功。
- “安排并记录”明确说明分步确认顺序，并在 MealLog 阶段尽量关联已确认计划项的真实 `planItemId`。
