---
name: shopping-list
description: 查询、创建、修改、删除或恢复购物清单项；不创建食材或食物档案，不处理采购完成入库或既有库存批次的独立消耗与销毁。
---

# 购物清单 Skill

## 用户目标

- 查询、创建、修改、删除或恢复购物清单项。
- 根据真实餐食计划 artifact、完整低库存集合和已有待买项整理采购建议并去重。
- 采购前计划和待办维护；任何“买到了 / 按小票入库 / 完成并入库”应路由到 `inventory_analysis`。

## 不适用范围

- 普通购物清单草稿 `shopping_list` 处理 create、update、delete 和 `set_done(done=false)` 恢复待买。
- 任何新的 `set_done(done=true)`、部分采购、仅完成不入库、批量采购或小票入库都由 `inventory_analysis` 通过 `inventory_intake` 处理；不得用普通购物草稿绕过一体化审批。
- 已有库存批次的独立入库、消耗和销毁交给 `inventory_analysis`；Ingredient/Food 建档交给对应 profile Skill；餐食计划交给 `meal_plan`。
- 每个新增采购项绑定当前家庭真实 Ingredient，或 `readyMade`、`instant`、`packaged` Food。不得把外卖、堂食或自制 Food 当作可采购成品。

## 工作模式

- `query`：调用 `shopping.read_pending`；默认 `status=pending`，查询已完成项目使用 `status=completed`，同时查看两类时使用 `status=all`。
- `create`：先用 `purchasable.resolve_candidates` 解析采购对象，再读取待买项和库存并去重。“低库存”“需要补货”“把库存不足的加入清单”必须调用 `inventory.read_low_stock_items`，因为它包含少量剩余和已经归零但配置了阈值的食材。
- `update/delete/restore`：先读取真实购物项，草稿携带 `targetId` 与 `baseUpdatedAt`。恢复待买按名称调用 `shopping.read_pending(status=completed)`，再生成 `set_done(done=false)`。
- `shopping.create_draft` 不得生成 `set_done(done=true)`；Tool 会拒绝并要求改用 `inventory.create_intake_draft`。
- `quantityMode` 只能是 `track_quantity` 或 `not_track_quantity`。presence-only 采购不硬填精确数量。

### 采购完成与入库

- 用户说“这些买到了”“按小票入库”“完成并入库”，或“实际只买了 / 剩下继续待买”的部分采购时，不要继续本 Skill 的草稿；路由或注入 `inventory_analysis`。
- 只有“这些都买到了”但没有小票、卡片选择、artifact 或明确列名时，可先调用 `shopping.read_pending` 帮助用户看清待买项，再用 `human.request_input` 让用户多选；不能默认选择当前家庭全部 pending 项。
- 正式匹配、单位处理、忽略行和统一入库草稿都由 `inventory_analysis` 使用既有读工具与 `inventory.create_intake_draft` 完成。

## 前置条件

- 新增采购草稿只能引用当前家庭真实 Ingredient 或 ready-like Food。
- 小票、卡片选择和 artifact 都只限定本次处理范围，不赋予跨家庭或绕过审批的权限。

## 候选处理

- `purchasable.resolve_candidates` 的 `exact` 才能直接绑定；`candidate` / `ambiguous` 必须请求选择；missing Ingredient 进入 `missing_ingredient`，missing ready-like Food 进入 `missing_ready_food`。
- 从做菜缺料派生时，只使用同会话最新真实 `recipe_shortage` artifact；逐个调用 `ingredient.read_by_id` 重读当前家庭食材。presence-only 缺料的模型 payload 省略 `quantity` 和 `unit`。
- 从餐食计划派生时只使用当前运行 `in_run:*` 草稿或同会话可读取的真实 artifact；完整内容通过 `workspace.read_artifact` 读取。
- `sourceDraftId` 只能来自当前运行 artifact 的 `in_run:*` ID，或同一会话真实存在的持久草稿 ID。

## Handoff

- `inventory.read_low_stock_items` 返回的 `ingredientId` 才是采购目标；`inventoryItemId` 只是批次 ID，不得写入购物项绑定字段。
- `missing_ingredient` / `missing_ready_food` continuation 每次只创建一个 profile 草稿；profile 审批成功后恢复本 Skill，不自动提交购物草稿。
- 部署前遗留的 `shopping_completed_ingredient` / `shopping_completed_food` continuation 只做历史兼容；新的“买到了”请求不再生成这条两阶段流程，也不再生成 `shopping_intake`。

## 审批规则

- 普通 create/update/delete/restore 仅通过 `shopping.create_draft` 生成 `shopping_list` 草稿。
- 采购完成与入库由 `inventory_analysis` 通过一份 `inventory_intake` 审批在一个事务中处理。
- `clientRequestId`、购物项/Ingredient/Food/state 的 row version 由后端归一化或计算，模型不得编造。

## 用户反馈

- 草稿前说明真实目标绑定、待买项去重与计划数量。
- 用户要完成采购时，说明将进入库存 Skill 做统一入库确认，而不是本 Skill 再生成第二份库存草稿。
- 不把“候选找到”说成“已经处理”，不在审批成功前声称购物项或库存已经变化。
