# AI Skill 优化说明

状态：首轮已落地到 catalog Skill 文档
更新时间：2026-06-28

本文基于当前 `backend/app/ai/skills/catalog/` 下的业务 Skill、`backend/app/ai/tools/schemas.py` 的 draft schema、`docs/ai-assistant-standards.md` 和前端现有选项配置，整理每个 Skill 后续可补强的说明项。

落地记录：2026-06-28 已把本文中的首轮规则补入 `food-profile`、`meal-record`、`shopping-list`、`meal-planning`、`inventory-analysis`、`recipe-draft`、`recipe-cook` 和 `ingredient-profile` 的 `SKILL.md` / `references/workflows.md`。后续如果新增字段、工具或前端固定选项，应继续按本文标准同步 Skill 说明。

目标不是引入新的真实数据聚合，也不是让 Skill 绕过工具或审批；目标是把 `ingredient_profile` 里已经明确的生成标准推广到其他 Skill：字段有限就用固定选项，有已有业务对象就优先选择已有对象，已有对象不合适时才进入对应资料补全流程，最后仍然通过 draft tool 生成可确认草稿。

## 统一优化标准

所有 Skill 后续更新时，建议统一写入以下规则。

1. 固定枚举只能选择，不能自定义。
   - 食物类型：`selfMade`、`takeout`、`diningOut`、`readyMade`、`instant`、`packaged`；前端新增食物手动创建不使用 `selfMade`，家常菜通常由菜谱同步沉淀。
   - 餐别：`breakfast`、`lunch`、`dinner`、`snack`。
   - 菜谱难度：`easy`、`medium`、`hard`。
   - 餐食计划状态：`planned`、`cooked`、`skipped`。
   - 库存操作：`restock`、`consume`、`dispose`。
   - 库存状态：`fresh`、`opened`、`frozen`、`expiring`。
   - 数量追踪：`track_quantity`、`not_track_quantity`。
   - 保质期模式：`days`、`manual_date`、`none`。
2. 前端已有预设优先，自定义只作为兜底。
   - 食材分类按前端编辑/审批表单当前可见选项使用：`蔬菜`、`肉类`、`水产`、`蛋奶`、`调料`、`水果`、`主食`、`豆制品`、`干货`、`其他`；保存位置和常用单位按 `ingredient_profile` 当前说明里的前端预设使用。
   - 食物类型、餐别来自 `frontend/src/components/foods/FoodWorkspaceOptions.ts` 和 AI 审批面板；展示标签保持 `家常菜`、`外卖`、`外食`、`成品`、`速食`、`包装食品`。
   - 菜谱餐别、购物常用单位、步骤图标来自 `frontend/src/components/recipes/RecipeWorkspaceOptions.ts`。
   - 库存 draft 的操作和状态来自 `frontend/src/components/ai/aiInventoryOperationDraftModel.ts`。
   - 这只是把前端已有固定选项写进 Skill 说明，不做真实食材分类聚合或动态选项聚合。
3. 业务引用必须优先用已有对象。
   - 食材用 `ingredient.search` / `ingredient.read_by_id`。
   - 食物用 `food.search` / `food.read_by_id`。
   - 菜谱用 `recipe.search` / `recipe.read_by_id`。
   - 计划、购物项、餐食记录和库存批次必须来自对应 read tool 的真实返回。
   - 搜索结果只是候选召回，不能把相似命中当成最终身份绑定；只有能明确判断为同一对象时才绑定真实 ID。
4. 已有对象不合适时，转入对应资料 Skill。
   - 缺食材档案：转入 `ingredient_profile`。
   - 缺食物资料：转入 `food_profile`。
   - 缺菜谱正文：转入 `recipe_draft`。
   - 不在当前 Skill 里伪造 ID、自由标题、库外食材或库外食物。
5. 草稿必须完整、可审批。
   - 不提交只有 `draftType` / `schemaVersion` 的空壳草稿。
   - update/delete/favorite/status/done/rate 等操作必须先读真实目标，带 `targetId`、`baseUpdatedAt` 和必要的 `before` 信息。
   - update payload 不是局部补丁；需要在真实详情基础上合成完整可编辑字段。
6. 追问要结构化。
   - 候选有限时用 `human.request_input` 的 choice 或 choice_or_text，列出候选摘要和为什么需要用户选。
   - 能安全推断的字段先填默认值，不把所有可编辑字段都抛回给用户。

## 1. `ingredient_profile` 食材档案

当前状态：

- 已经明确 `action`、`quantity_tracking_mode`、`default_expiry_mode` 只能用固定值。
- 已经写入前端食材编辑/审批表单当前可见分类、保存位置和常用单位预设，并要求系统固定选项优先、前端预设优先、确实不合适才自定义。
- 已经要求创建前先搜索已有食材，更新前读取真实详情，并处理多食材创建的逐项确认节奏。

建议补强：

- 保留现有说明作为其他 Skill 的基准，不要改成真实食材聚合或后端动态分类聚合。
- 在 Skill 顶部保留“本 Skill 的分类和单位预设来自前端编辑/审批表单当前可见选项，不代表真实库存聚合结果”，避免模型把预设理解成数据库事实。
- 对 `default_expiry_days` 再补一句：只有 `default_expiry_mode=days` 时填写；`manual_date` 和 `none` 不要同时填写天数。
- 对图片字段补充更硬的规则：更新时没有明确换图就不要传 `media_ids`，避免空数组被误解为清空媒体。

建议落点：

- `backend/app/ai/skills/catalog/ingredient-profile/SKILL.md`

## 2. `food_profile` 食物资料

当前状态：

- 已要求先 `food.search`，更新/收藏前读取真实食物详情。
- 已写入食物类型映射和必填字段规则。
- 已区分 `set_favorite` 与资料更新，避免收藏混入完整 payload。

建议补强：

- 把前端食物类型固定选项写得更明确：手动创建优先使用 `takeout`、`diningOut`、`readyMade`、`instant`；`selfMade` 通常来自菜谱同步，不应为了创建普通食物资料随意使用。
- `suitable_meal_types` 只能从 `breakfast`、`lunch`、`dinner`、`snack` 中多选；用户只说“正餐”时优先映射到 `lunch` / `dinner`，不创建“正餐”自定义值。
- `rating` 只能是 1 到 5 的整数；`price`、`stock_quantity` 不能为负；没有证据时留空。
- `category` 可以自定义，但应优先使用前端 AI 审批表单的常见类别文案：主食、饮品、早餐、便当、零食、甜品、汤粥、小吃、外卖、速食；不要为了细分随意创造很长类别。
- 如果用户要把一个食物关联菜谱，`recipe_id` 必须来自真实菜谱，并且食物名称跟菜谱标题保持一致；菜谱不存在时转入 `recipe_draft`。

建议落点：

- `backend/app/ai/skills/catalog/food-profile/SKILL.md`

## 3. `recipe_draft` 菜谱管理

当前状态：

- 已要求生成菜谱前逐项搜索食材，`ingredient.search` 只作为候选召回，最终只绑定真实食材 ID。
- 已要求缺失食材先进入 `ingredient_profile`，并按菜谱逐个闭环处理。
- 已要求 update/delete/favorite 前读取真实菜谱目标。

建议补强：

- 明确 `difficulty` 只能选择 `easy`、`medium`、`hard`，不要生成“简单”“中等偏难”等自由值。
- `steps[].icon` 优先从前端步骤图标预设选择：`pan`、`tomato`、`bowl`、`timer`、`tip`、`plate`；没有把握时用 `pan` 或按步骤语义选择，不自定义图标值。
- `scene_tags` 优先使用前端常见场景：工作日晚餐、孩子也能吃、周末轻食、高蛋白、早餐、汤羹；其他标签可以自定义，但要短、可展示、不要堆叠同义词。
- `prep_minutes`、`servings` 必须给可执行数字；不确定时先用常见可编辑默认值或追问，不要写“适量时间”“多人份”。
- 食材单位继续遵循候选食材 `defaultUnit` / `supportedUnits`；没有换算关系时追问或转入食材档案流程，不把 unsupported unit 直接提交。
- `script.lint_recipe_draft` 只作为早期质量检查，不是安全边界；说明中可保留“调用后仍必须用 `recipe.create_draft` 做最终校验”。

建议落点：

- `backend/app/ai/skills/catalog/recipe-draft/SKILL.md`

## 4. `recipe_cook` 菜谱做菜

当前状态：

- 已明确只处理已有菜谱实际做一次菜。
- 已要求锁定唯一真实菜谱、按菜谱过滤计划项、先 preview，再在无缺料时生成 `recipe_cook` 草稿。
- 已要求确认前不能扣库存、写做菜日志、写餐食记录或完成计划。

建议补强：

- `mealType` 只能从固定餐别选择；用户没说餐别且需要记录餐食时，按当前时间推断仍应落到固定值，不写自由文案。
- `createMealLog` 是布尔决策：用户明确说“记录餐食、吃了、完成计划并记录”才设为 true；普通“扣库存”保持 false。
- `rating` 只能是 1 到 5 的整数；没有明确评分时留空，不根据语气自动打分。
- `participantUserIds` 必须来自真实家庭成员上下文或用户明确选择；当前 Skill 没有成员读取工具时，不应编造成员 ID。
- 计划关联失败时继续保持现有规则：不要复用历史摘要里的计划 ID，不要把 `foodPlanItemId` 或旧字段名当作可信来源。

建议落点：

- `backend/app/ai/skills/catalog/recipe-cook/SKILL.md`

## 5. `meal_plan` 餐食计划

当前状态：

- 已区分即时推荐和正式计划。
- 正式计划要求 `foodId` 来自真实食物，`recipeId` 只能使用所选食物已关联的真实菜谱。
- 修改、删除和状态变更要求读取真实计划项。

建议补强：

- `mealType` 只能从固定餐别选择；“早饭/早餐”映射 `breakfast`，“夜宵/加餐”优先映射 `snack`，不自定义餐别。
- `set_status` 只能使用 `planned`、`cooked`、`skipped`；“已做/完成”映射 `cooked`，“不吃/跳过”映射 `skipped`。
- 计划项必须优先使用已有食物；食物库没有匹配时停止计划草稿，转入 `food_profile`，不要提交自由标题。
- 缺失食材提醒里的 `ingredientId` 能匹配已有食材时必须绑定；不能匹配时可以作为计划缺料提醒保留名称，但不能假装已创建食材档案。
- 从历史计划草稿修改时，必须先用 `workspace.read_artifact` 读取完整 items；不要根据摘要补全日期、餐别或食物 ID。
- 即时推荐 `meal_plan.recommend_today` 每个推荐项只传真实 `foodId` 或 `recipeId`，展示字段交给工具补齐。

建议落点：

- `backend/app/ai/skills/catalog/meal-planning/SKILL.md`
- `backend/app/ai/skills/catalog/meal-planning/references/workflows.md`

## 6. `meal_log` 餐食记录

当前状态：

- 已要求 `foods[].foodId` 来自真实食物。
- 已要求食物不在食物库时先补充食物资料。
- 已区分 create、update_details、rate_food，并要求更新前读取真实餐食记录。

建议补强：

- `mealType` 只能从固定餐别选择，不能生成“夜宵”“下午茶”等自由值；夜宵/下午茶默认映射为 `snack`。
- `foods[].servings` 必须大于 0；用户没说份数时默认 1 份，并在草稿中让用户可改。
- `foods[].rating` 和 `rate_food.payload.foodEntryRatings[].rating` 只能在 0.5 到 5 之间；没有明确评分时留空。
- `mood` 可自定义，但优先使用前端展示友好的短词，如满足、清淡、匆忙、聚餐、孩子喜欢；不要输出长句或诊断式营养评价。
- `participantUserIds` 和 `mediaIds` 只能来自真实上下文或审批表单，Skill 不编造 ID；如果需要用户补充参与人或照片，使用 `human.request_input` 或说明可在审批表单核对。
- `planItemId` 只能来自真实计划项；如果当前 Skill 没有查计划工具，就不要根据用户文字或历史摘要绑定计划项。

建议落点：

- `backend/app/ai/skills/catalog/meal-record/SKILL.md`

## 7. `inventory_analysis` 库存查看与处理

当前状态：

- 已明确纯查询只返回 `inventory_summary`，写操作必须生成 `inventory_operation` 草稿。
- 已写入入库单位换算澄清流程和副单位保存转入 `ingredient_profile` 的规则。
- 已要求不存在的食材不能自行创建。

建议补强：

- `action` 只能是 `restock`、`consume`、`dispose`；不要输出“补货”“扣减”“扔掉”等中文自由值。
- 入库 `status` 只能是 `fresh`、`opened`、`frozen`、`expiring`；没有明确开封、冷冻或临期时默认 `fresh`，但到期日期仍按用户/食材规则填写。
- `storageLocation` 优先使用食材默认保存位置或前端保存位置预设：冷藏、冷冻、常温；用户明确给出家庭位置才自定义。
- `unit` 优先使用食材 `supportedUnits`；不支持时走本次换算追问，不试错调用 draft tool。
- `dispose` 必须绑定真实库存批次并填写原因；`consume` 可以省略批次让后端按默认顺序扣减；`restock` 必须绑定真实食材。
- 低库存阈值、保质期天数、到期日期等没有证据时不要编造。

建议落点：

- `backend/app/ai/skills/catalog/inventory-analysis/SKILL.md`

## 8. `shopping_list` 购物清单

当前状态：

- 已要求具体食材先查真实食材资料；没有匹配时可以保留用户原名称作为可编辑采购项，但不编造食材 ID。
- 已要求修改、删除、标记买到前读取真实购物项。
- 已要求从计划派生时引用真实 artifact，并结合库存和待买项避免重复。

建议补强：

- `quantityMode` 只能是 `track_quantity` 或 `not_track_quantity`；用户只想提醒“买点香菜”时用 `not_track_quantity` 和展示文案，不硬填精确数量。
- 单位优先用食材默认单位、支持单位或前端购物常用单位：个、颗、盒、袋、斤、克、瓶、把、份、片；确实是用户明确单位时才自定义。
- `set_done` 的 `done` 只能是布尔值；“买到了/完成”映射 true，“恢复待买/还没买”映射 false。
- 已有待买项相似时，优先生成 update 或追问是否合并，不直接重复 create。
- 如果用户明确要买某个食材且 `ingredient.search` 有明确匹配，采购项应绑定 `ingredientId`；无匹配时可保留自由 title，但要说明它只是购物提醒，不是食材档案。
- 从 meal_plan artifact 派生时，缺失食材如果已有真实 `ingredientId` 就绑定；没有 ID 的只作为采购名称，不能反向创建食材档案。

建议落点：

- `backend/app/ai/skills/catalog/shopping-list/SKILL.md`
- `backend/app/ai/skills/catalog/shopping-list/references/workflows.md`

## 建议实施顺序

1. 先更新 `food_profile`、`meal_log`、`shopping_list`：这些 Skill 当前最容易把可选字段写成自由文本，且前端已经有明确下拉/选择器。
2. 再更新 `meal_plan`、`inventory_analysis`：主要补枚举映射和已有对象优先规则，减少无效草稿。
3. 最后微调 `recipe_draft`、`recipe_cook`、`ingredient_profile`：这三者现有边界较强，主要补前端预设、枚举和媒体/成员 ID 约束。

## 验证建议

文档落地到 Skill 后建议做以下验证：

- 运行 Skill loader/registry 相关测试，确保 `SKILL.md` 和 `skill.yaml` 仍能加载。
- 对每个 draft tool 补或更新一组 AI infra 测试，覆盖固定枚举、真实 ID 绑定和空壳草稿拒绝。
- 对前端审批 UI 的下拉/自定义输入保持已有 draft UI 测试覆盖，避免 Skill 输出和 UI 可编辑字段再次漂移。
