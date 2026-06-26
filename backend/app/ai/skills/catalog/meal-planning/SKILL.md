---
name: meal-planning
description: 处理“今天/今晚吃什么”的即时餐食推荐，以及未来或指定日期餐食计划的创建、修改、删除和状态变更；不记录已吃餐食、不执行做菜扣库存、不生成购物清单或菜谱正文。
---

# 餐食计划 Skill

## 自主决策空间

- 可以根据用户意图在即时推荐和正式计划之间选择模式；没有明确计划范围时优先即时推荐，有日期、天数、餐别或“安排/制定/生成/修改”语义时进入正式计划。
- 可以自主选择读取库存、临期食材、最近餐食、食物和菜谱的顺序；不需要机械调用全部工具，但推荐和计划必须能追溯到真实工具结果。
- 推荐理由、口味解释、避免重复的说明和可编辑备注可以自由组织；正式计划里的 `foodId`、`recipeId`、日期和餐别必须可校验。
- 用户目标唯一且工具结果明确时，不要重复追问；计划范围、修改目标或同日同餐候选不明确时才请求澄清。
- 需要把“从明天开始三天晚餐”“周末午晚餐”等范围展开为具体日期/餐别时，可调用 `script.expand_meal_slots` 做确定性展开。

## 模式选择

### 即时推荐模式

- 适用于“今天吃什么”“今晚吃什么”“推荐一餐”等没有明确计划范围的请求。
- `quickTask=today_recommendation` 时必须使用此模式。
- 读取库存、临期食材、最近餐食，并按需查询食物和菜谱。
- 优先临期库存，尽量避免最近重复，返回 1–3 个当前家庭已有食物或菜谱候选。
- 调用 `meal_plan.recommend_today` 返回 `today_recommendation` 卡片，不调用 `meal_plan.create_draft`，不创建审批。
- 每个推荐项必须提供工具返回的真实 `foodId` 或 `recipeId`，不得只返回自由文本标题。
- `meal_plan.recommend_today` 的 `recommendations[]` 参数只传真实 ID、理由和证据；不要自造卡片 JSON。
- 如果用户询问中包含日期或餐次，必须传入 `targetDate` 和 `mealType`：`targetDate` 使用 `YYYY-MM-DD`，`mealType` 使用 `breakfast`、`lunch`、`dinner` 或 `snack`。
- 推荐项名称、图片、分类、制作时间、份量等展示字段由 `meal_plan.recommend_today` 根据真实 ID 补齐，不得编造。

### 正式计划模式

- 适用于“安排、制定、生成、修改餐食计划”，或用户给出日期、天数、餐别等计划范围的请求。
- 创建或修改时必须调用 `meal_plan.create_draft`。
- 新增可以生成创建型草稿；修改、删除和状态变更必须生成带 `action`、`targetId` 和 `baseUpdatedAt` 的操作草稿。
- 修改计划必须先通过 `meal_plan.read_by_id` 或明确的列表读取拿到真实目标，不能只靠名称猜测。
- 历史 artifact 默认只提供摘要和 ID；如果要复用或修改历史 AI 草稿的完整 `items`，先调用 `workspace.read_artifact` 按 ID 读取，不要根据摘要补全计划项。
- 同一天同餐别存在多条计划、用户未说明计划范围或要修改哪条计划时，调用 `human.request_input`，并提供候选摘要。
- 状态变更使用 `set_status`，仅允许 `planned`、`cooked` 和 `skipped`。

## 共同规则

- 所有推荐和计划都应参考当前库存、临期食材与最近餐食。
- 正式计划的 `foodId` 必须来自 `food.search` 或 `food.read_by_id`，且标题必须使用对应食物名称。
- `recipeId` 只能使用所选食物已关联的真实菜谱；没有关联时填 `null`。
- 如果正式计划需要的食物不在食物库中，说明需要先补充食物资料，不得创建无效草稿，也不要在本 Skill 中调用或伪造 `food_profile` 草稿；由 Orchestrator 注入食物资料流程。
- 创建草稿前调用 `script.validate_meal_plan` 做确定性结构检查；需要文本预览时可调用 `script.render_plan_preview`。
- `FoodPlanItem` 读取范围以当前用户和家庭时区为准，不得越过当前用户读取其他成员的个人计划。
- 不直接写入正式 `FoodPlanItem`，草稿确认后由后端根据操作类型完成写入。
