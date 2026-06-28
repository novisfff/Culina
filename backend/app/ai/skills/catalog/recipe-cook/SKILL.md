---
name: recipe-cook
description: 按已有菜谱实际做一次菜，预览缺料和库存扣减，并在可做时生成做菜执行草稿，可关联计划和可选记录餐食；不新建/编辑菜谱、不做普通餐食记录或未来餐食安排。
---

# 菜谱做菜 Skill

历史 artifact 默认只提供摘要和 ID；需要复用历史 AI 草稿或审批详情时，先调用 `workspace.read_artifact`，不要根据摘要补全库存扣减或做菜记录。

## 定位

`recipe_cook` 只处理“按已有菜谱实际做一次菜”：查真实菜谱、可选关联同一菜谱的餐食计划、预览库存扣减，并在库存充足时生成待用户确认的做菜草稿。确认前不能扣库存、写做菜日志、写餐食记录或完成计划。

不处理：

- 新建、编辑、删除或收藏菜谱；这些请求走 `recipe_draft`。
- 临时生成一个不存在的菜谱再做菜；菜谱不存在时提示用户先创建菜谱。
- 普通餐食记录；没有做菜扣库存语义时走 `meal_log`。

## 自主决策空间

- 可以根据用户原话决定是否查计划、是否记录餐食和使用什么份数默认值；没有计划关联语义时不必查计划。
- 用户只说“做这道菜并扣库存”时，默认不创建餐食记录；明确说“记录/吃了/完成计划”时再设置 `createMealLog=true`。
- 菜谱目标唯一、份数可安全使用菜谱默认值时不要重复追问；会影响扣库存或计划完成的关键信息不明确时必须澄清。
- 回复文案可以自由解释缺料、扣减预览和确认后会发生什么，但不能承诺确认前已经扣减或完成计划。

## 字段取值规则

- `mealType` 只能从 `breakfast`、`lunch`、`dinner`、`snack` 中选择；用户没说餐别且需要记录餐食时，可以按上下文或默认晚餐推断，但最终必须落到固定值。
- `createMealLog` 是布尔决策：用户明确说“记录餐食、吃了、完成计划并记录”才设为 `true`；普通“做菜并扣库存”保持 `false`。
- `rating` 只能是 1 到 5 的整数；用户没有明确评分时留空，不根据语气自动打分。
- `participantUserIds` 必须来自真实家庭成员上下文或用户明确选择；当前 Skill 没有成员读取工具时，不要编造成员 ID。
- `planItemId` 只能来自按当前 `recipeId` 过滤后的 `meal_plan.read_existing` 返回项；不要复用历史摘要、旧字段名或未过滤计划列表里的 ID。

## 建议流程

### 1. 解析意图

从用户话里提取：

- 菜谱目标：菜名、菜谱 id、上一轮用户明确选择的菜谱。
- 份数：明确份数、默认使用菜谱默认份数；如果用户表达含糊且会影响库存扣减，先澄清。
- 日期和餐别：用户提到“今晚、明天早餐、周五晚餐”等时转成 `date/planDate` 和 `mealType`。
- 是否关联计划：只有用户说“做掉计划、按计划做、今晚计划那道、完成计划”等，才查并关联计划项。
- 是否生成餐食记录：只有用户明确说“记录餐食、吃了、记一笔、完成计划并记录、做掉计划”等，才设置 `createMealLog=true`；普通“做这道菜并扣库存”默认 `createMealLog=false`。

### 2. 锁定唯一真实菜谱

- 先调用 `recipe.search` 或 `recipe.read_by_id`。
- 必须锁定唯一 `recipeId` 后才能继续。
- 没找到菜谱时调用 `human.request_input` 或直接说明“请先创建菜谱”，不要调用 `recipe.create_cook_draft`，也不要临时生成菜谱。
- 找到多个候选菜谱时调用 `human.request_input`，候选项必须来自 `recipe.search` 返回结果。

### 3. 可选关联计划项

只有“需要关联计划”时才查计划。查计划必须满足：

- 已经有唯一 `recipeId`。
- 调用 `meal_plan.read_existing` 时必须传 `recipeId`。
- 用户提到日期时同时传 `planDate`；用户提到餐别时同时传 `mealType`。
- 只允许使用 `meal_plan.read_existing` 返回项中 `item.recipeId == recipeId` 的 `item.id` 作为 `planItemId`。
- 不允许从历史消息、推荐卡、旧草稿、未过滤计划列表或字段名 `foodPlanItemId` 中复用计划 id。
- 没有匹配计划项时，调用 `human.request_input` 让用户选择“不关联计划继续”或补充正确计划。
- 多个匹配计划项时，调用 `human.request_input`，必须展示每个候选的日期、餐别、标题、状态；不要自动选最近项。

### 4. 预览库存

- 调用 `recipe.preview_cook`，传入 `recipeId`、份数，只有通过第 3 阶段确认的计划项才传 `planItemId`。
- 如果 `recipe.preview_cook` 返回 `planItemWarning`，说明流程前面没有按 `recipeId` 正确查计划；不要继续把该 `planItemId` 传给 `recipe.create_cook_draft`。用户明确要求做掉计划时，必须重新按第 3 阶段查询或澄清；用户只是要求做菜并记录餐食时，可以不关联计划继续。
- 预览中有 `shortages` 时，不生成 `recipe_cook` 草稿，也不要让用户确认一个注定会失败的执行。直接说明缺少哪些食材、建议先补库存或调整份量；需要用户选择时调用 `human.request_input`。

### 5. 生成确认草稿

- 只能调用 `recipe.create_cook_draft` 生成 `recipe_cook` 草稿。
- 只有 `recipe.preview_cook` 返回的 `shortages` 为空时才生成草稿。
- 草稿里的 `recipeId`、`baseUpdatedAt`、`planItemId`、`planItemBaseUpdatedAt`、`previewItems`、`shortages` 必须来自工具结果。
- 未明确要求记录餐食时，`createMealLog=false`。
- 明确要求记录餐食或完成计划时，`createMealLog=true`，并按用户意图带上日期、餐别和参与人。
- 生成草稿后等待用户确认；不要直接调用任何正式写入工具。

## 澄清触发条件

以下情况必须调用 `human.request_input`：

- 菜谱不存在或菜谱候选不唯一。
- 用户要求关联计划，但计划项不存在或不唯一。
- 份数不明确且无法安全使用菜谱默认份数。
- 预览缺料且用户需要在“补库存、调整份量、换菜谱”之间选择。
- 用户同时表达互相冲突的日期、餐别、计划项或记录餐食要求。

## 安全边界

- `planItemId` 是强绑定字段，只能来自按当前 `recipeId` 过滤后的 `meal_plan.read_existing`。
- `recipe.create_cook_draft` 和最终审批执行仍会严格校验 `planItemId` 与 `recipeId` 是否匹配。
- 缺料不允许负库存扣减；发现缺料时不要生成执行草稿。最终审批执行如果库存状态在确认前变成缺料，必须失败并提示刷新预览或先补库存。
