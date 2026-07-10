---
name: meal-planning
description: 处理“今天/今晚吃什么”的即时餐食推荐，以及未来或指定日期餐食计划的创建、修改、删除和状态变更；不记录已吃餐食、不执行做菜扣库存、不生成购物清单或菜谱正文。
---

# 餐食计划 Skill

## 用户目标

- 回答“今天/今晚吃什么”的即时推荐，或创建、修改、删除和更新未来/指定日期的餐食计划。
- 推荐和正式计划参考当前库存、临期食材与最近餐食，并绑定当前家庭真实 Food 或 Recipe。

## 不适用范围

- 已经发生的用餐记录交给 `meal_log`；按菜谱实际做菜并扣库存交给 `recipe_cook`。
- 不生成购物清单、菜谱正文或自由 Food 标题。
- “安排/作为今天晚餐/放到今晚菜单”是餐食计划，不是已吃记录；只有“吃了/已吃/记录”才涉及 `meal_log`。

## 工作模式

- `query`：无明确计划范围的“今天吃什么/推荐一餐”使用即时推荐。读取库存、临期、最近餐食并调用 `meal_plan.recommend_today` 返回 1 到 3 个真实候选，不创建审批。
- 只有 Food 和 Recipe 搜索都没有合适真实候选时，才可基于库存中的真实 Ingredient ID 调用 `meal_plan.propose_from_inventory`；该卡片只是餐食想法，不是 Food、Recipe 或正式计划。
- `create`：有日期、天数、餐别或“安排/制定/生成”语义时进入正式计划，调用 `meal_plan.create_draft`。
- `update`：修改、删除和状态变更前读取真实目标，草稿带 `action`、`targetId`、`baseUpdatedAt`；状态只能是 `planned`、`cooked`、`skipped`。
- `mealType` 只能是 `breakfast`、`lunch`、`dinner`、`snack`。范围展开可调用 `script.expand_meal_slots`，草稿前调用 `script.validate_meal_plan`。

## 前置条件

- 推荐项必须有工具返回的真实 `foodId` 或 `recipeId`；名称、图片、分类、制作时间等由工具按真实 ID 补齐。
- 正式计划的 `foodId` 来自 `food.search` 或 `food.read_by_id`，标题与 Food 名称一致；`recipeId` 只使用该 Food 已关联的真实菜谱，否则为 `null`。
- 修改计划用 `meal_plan.read_by_id` 或明确列表定位；历史 artifact 只有摘要时先调用 `workspace.read_artifact` 读取完整 `items`。
- `FoodPlanItem` 读取按当前用户和家庭时区隔离，不越权读取其他成员个人计划。

## 候选处理

- `food.search` 和 `recipe.search` 只做候选召回；同日同餐多条计划、计划范围或修改目标不明确时调用 `human.request_input`。
- 正式计划需要的 Food 不存在时不得提交自由标题或虚构 ID，进入 `missing_food` handoff；不要在本 Skill 中调用或伪造 `food_profile` 草稿。
- 缺失食材提醒能匹配真实 Ingredient 时绑定真实 ID；不能匹配时可保留名称作为提醒，但不能假装已建档。
- 即时推荐优先临期库存并避免近期重复；候选理由必须能追溯到工具结果。
- 库存想法必须逐个绑定当前家庭真实 Ingredient ID，并展示当前可用性；不能生成虚假的 Food ID、Recipe ID 或餐食计划项。已有合适 Food/Recipe 时必须优先使用真实库候选。

## Handoff

- `missing_food`：正式计划所需 Food 不存在时，typed `continuation` 指向 `food_profile`，`requiredDraftType=food_profile`，审批后恢复 `meal_plan`，state 使用 `meal_missing_food.v1`。
- continuation state 只保存目标名称、日期、餐别和简短 instruction；Food 审批成功后恢复本 Skill，再由模型基于真实 Food 生成餐食计划草稿。
- 用户目标是“安排并记录”时保留原始完整目标；计划审批完成后由 Orchestrator 基于审批 artifact 和原始目标决定是否注入 `meal_log`，不能在本草稿中藏自由格式后续指令，也不能自动生成下一草稿。
- 用户接受 `meal_idea_proposal` 时开启新的 `recipe_draft` 用户轮次；提案本身不走 approval continuation，也不能直接创建 MealPlan。

## 审批规则

- 即时推荐是只读终态，不生成草稿。
- `meal_idea_proposal` 同样是只读终态；必须先经用户动作进入菜谱整理并完成菜谱审批，之后正式计划才能引用真实实体。
- 正式计划仅通过 `meal_plan.create_draft`，遵循 `draft -> approval -> commit`；确认前不写正式 `FoodPlanItem`。
- continuation 只负责恢复能力；运行时不得在审批成功后自动生成或提交下一个草稿。

## 用户反馈

- 即时推荐说明库存、临期和避重依据；正式计划草稿前说明日期范围、餐别和候选来源。
- Food 缺失时说明先补真实 Food，再恢复当前计划，不声称已经安排成功。
- “安排并记录”按顺序反馈：先确认计划，之后再处理用餐记录，并尽量使用已确认计划项的真实 `planItemId`。
- 库存想法要明确说明“尚未创建菜谱或计划”，用户接受后下一步只是整理菜谱草稿。
