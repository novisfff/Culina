---
name: shopping-list
description: 查询、创建、修改、删除或恢复购物清单项，并处理单项或批量采购完成、部分购买、小票匹配和一体化库存入库；不创建食材或食物档案，不处理既有库存批次的独立消耗与销毁。
---

# 购物清单 Skill

## 用户目标

- 查询、创建、修改、删除或恢复购物清单项。
- 根据真实餐食计划 artifact、完整低库存集合和已有待买项整理采购建议并去重。
- 将单项或批量“买到了”通过一份审批同时更新购物项与库存。
- 从小票或用户列出的实际采购内容中，只处理能匹配当前家庭真实 pending 购物项的行；未匹配内容作为额外购买候选说明后续建议。

## 不适用范围

- 普通购物清单草稿 `shopping_list` 处理 create、update、delete 和 `set_done(done=false)` 恢复待买。
- 任何新的 `set_done(done=true)`、部分采购、仅完成不入库或批量采购都使用 `shopping_intake`，不得用普通购物草稿绕过一体化审批。
- 已有库存批次的独立入库、消耗和销毁交给 `inventory_analysis`；Ingredient/Food 建档交给对应 profile Skill；餐食计划交给 `meal_plan`。
- 每个新增采购项绑定当前家庭真实 Ingredient，或 `readyMade`、`instant`、`packaged` Food。不得把外卖、堂食或自制 Food 当作可采购成品。

## 工作模式

- `query`：调用 `shopping.read_pending`；默认 `status=pending`，查询已完成项目使用 `status=completed`，同时查看两类时使用 `status=all`。
- `create`：先用 `purchasable.resolve_candidates` 解析采购对象，再读取待买项和库存并去重。“低库存”“需要补货”“把库存不足的加入清单”必须调用 `inventory.read_low_stock_items`，因为它包含少量剩余和已经归零但配置了阈值的食材。
- `update/delete/restore`：先读取真实购物项，草稿携带 `targetId` 与 `baseUpdatedAt`。恢复待买按名称调用 `shopping.read_pending(status=completed)`，再生成 `set_done(done=false)`。
- `shopping.create_draft` 不得生成 `set_done(done=true)`；Tool 会拒绝并要求改用 `shopping.create_intake_draft`。
- `quantityMode` 只能是 `track_quantity` 或 `not_track_quantity`。presence-only 采购不硬填精确数量。

### 采购完成与入库

#### 明确作用域

- 有小票时，只处理小票匹配到的 pending 项。
- 有卡片选择或当前 run artifact 时，只处理其中明确选择的真实购物项。
- 用户明确列名时，逐项查询并唯一定位。
- 只有“这些都买到了”但没有小票、卡片选择、artifact 或明确列名时，先调用 `shopping.read_pending`，再用 `human.request_input` 让用户多选；不能默认选择当前家庭全部 pending 项。

## 前置条件

- `shopping_intake` 只能引用当前家庭、仍为 pending 的真实购物项；购物项和入库 Ingredient/Food 必须是同一个已绑定目标。
- `shopping.preview_intake_candidates` 返回的购物项、目标 ID 和版本上下文是真相源；模型输入的 expected version、state ID 和 canonical actual quantity不可信。
- 没有可靠实际数量时允许生成待补充草稿，但批准前必须补齐；presence Ingredient 和 `complete_without_inventory` 除外。
- 小票、卡片选择和 artifact 都只限定本次处理范围，不赋予跨家庭或绕过审批的权限。

## 候选处理

### 匹配顺序

1. 将小票或用户输入整理为行：名称、可靠的实际数量、单位，以及可选的明确 `shoppingItemId`。
2. 调用 `shopping.preview_intake_candidates`，使用它返回的真实 ID 和版本上下文，不自行编造匹配。
3. `confirmed` 可直接进入草稿。
4. `suggested` 是唯一合理候选，可自动预选，但草稿必须展示 `matchReason`；用户批准整份草稿即接受该建议。
5. `ambiguous` 必须先请求用户选择真实购物项或目标，不能提交仍为 ambiguous 的行。
6. `unmatched` 不进入本次事务，放入 `unmatchedCandidates`，明确标注“不会随本次提交”。

### 额外购买候选

- 未匹配但能定位现有 Ingredient/ready-like Food：建议用户随后单独登记库存。
- 缺 Ingredient：建议进入 `ingredient_profile` 创建食材档案。
- 缺 ready-like Food：建议进入 `food_profile` 创建食物资料。
- 有多个实体候选：建议先选择真实目标。
- 候选只提供建议；本次审批不自动建档、不自动入库、不创建隐藏购物项。

### 数量与每行动作

- 有可靠小票或用户证据时填写 `enteredQuantity`、`enteredUnit`；没有可靠实际数量时保持为空，不得用 planned quantity 代替。
- 一次性包装换算只有在小票或用户明确提供时才填写 `packageConversion`，并保留倍率、目标单位和证据，例如 `1 箱 × 12 盒/箱 = 12 盒`。不得把一次性换算写回长期单位配置。
- 每个匹配行可选择 `stock_and_fulfill` 或 `complete_without_inventory`。
- actual < planned：入库实际数量，保留剩余待买。
- actual = planned：完成并入库。
- actual > planned：实际数量全部入库，购物项完成，并在审批摘要提示超额。
- presence Ingredient 不要求精确数量，采购后更新为非 absent 状态并完成购物项。

## Handoff

- `inventory.read_low_stock_items` 返回的 `ingredientId` 才是采购目标；`inventoryItemId` 只是批次 ID，不得写入购物项绑定字段。
- `purchasable.resolve_candidates` 的 `ambiguous` 结果必须请求选择；missing Ingredient 进入 `missing_ingredient`，missing ready-like Food 进入 `missing_ready_food`。
- 从做菜缺料派生时，只使用同会话最新真实 `recipe_shortage` artifact；逐个调用 `ingredient.read_by_id` 重读当前家庭食材。presence-only 缺料的模型 payload 省略 `quantity` 和 `unit`。
- 从餐食计划派生时只使用当前运行 `in_run:*` 草稿或同会话可读取的真实 artifact；完整内容通过 `workspace.read_artifact` 读取。
- `sourceDraftId` 只能来自当前运行 artifact 的 `in_run:*` ID，或同一会话真实存在的持久草稿 ID。
- `missing_ingredient` / `missing_ready_food` continuation 每次只创建一个 profile 草稿；profile 审批成功后恢复本 Skill，不自动提交购物草稿。
- 部署前遗留的 `shopping_completed_ingredient` / `shopping_completed_food` continuation 只做历史兼容；新的“买到了”请求不再生成这条两阶段路径。

## 审批规则

- 普通 create/update/delete/restore 仅通过 `shopping.create_draft` 生成 `shopping_list` 草稿。
- 采购完成仅通过 `shopping.create_intake_draft` 生成 `shopping_intake.v1` 草稿。
- 单项或批量采购都只生成一份审批；确认后在一个事务中更新购物项、库存和 InventoryOperation。
- 任一行 stale、目标失效、单位不兼容或字段验证失败时整批回滚，不允许 partial success。
- `clientRequestId`、购物项/Ingredient/Food/state 的 row version 和 canonical actual quantity 由后端归一化或计算，模型不得编造。
- 缺实际数量、换算证据、存放位置或仍有歧义时可以先展示 pending 草稿，但必须在审批表单补齐并阻止无效提交。
- `unmatchedCandidates` 是只读展示，executor 永远忽略。

## 用户反馈

- 草稿前说明真实目标绑定、待买项去重、每行实际数量和是否入库。
- suggested 行解释匹配依据；缺数量、换算或歧义行明确指出需要补充什么。
- 未匹配行统一放在正式采购项之后，说明“不随本次提交”，并给出建 Ingredient、建 ready-like Food、选择真实目标或后续单独入库的推荐动作。
- 不把“候选找到”说成“已经处理”，不在审批成功前声称购物项或库存已经变化。
