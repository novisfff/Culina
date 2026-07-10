---
name: shopping-list
description: 创建、修改、删除或标记购物清单项，可根据餐食计划草稿、库存缺口和已有待买项派生采购建议；不处理库存入库、不创建食材档案、不制定餐食计划。
---

# 购物清单 Skill

## 用户目标

- 查询、创建、修改、删除或标记购物清单项。
- 根据真实餐食计划 artifact、库存缺口和已有待买项整理采购建议并去重。
- 每个采购项绑定当前家庭真实 Ingredient，或 `readyMade`、`instant`、`packaged` Food。

## 不适用范围

- 已买到后的库存入库交给 `inventory_analysis`；Ingredient/Food 建档交给对应 profile Skill；餐食计划交给 `meal_plan`。
- 不允许自由文本采购对象，不把搜索或语义候选自动当作已绑定实体。
- 不将外卖、堂食或自制 Food 作为 ready-like 可采购 Food。

## 工作模式

- `query`：读取 `shopping.read_pending` 或真实购物项，只摘要不生成草稿。
- `create`：先批量调用 `purchasable.resolve_candidates` 解析采购对象，再读取待买项和可用库存，排除已有库存覆盖与重复项。
- `update`：修改、删除、完成和恢复待买前读取真实购物项，草稿带 `action`、`targetId`、`baseUpdatedAt`；状态变更使用 `set_done`。
- `quantityMode` 只能是 `track_quantity` 或 `not_track_quantity`；只要提醒“买点香菜”时使用 presence-only，不硬填数量。
- 每个 create/update payload 必须二选一携带真实 `ingredientId` 或 ready-like `foodId`，不能同时带两者。

## 前置条件

- `purchasable.resolve_candidates` 一次最多解析 30 个名称；Ingredient 与 ready-like Food 都按当前家庭过滤。
- `exact` 才可直接绑定；语义候选仍需模型根据实体类型、名称、分类、单位和上下文确认。
- 从计划派生时使用当前运行 `in_run:*` 草稿或同会话可读取的真实 artifact；需要完整 `items` 时调用 `workspace.read_artifact`。
- `sourceDraftId` 只能来自当前运行 artifact 的 `in_run:*` ID，或同一会话中真实存在的持久草稿 ID；不能从文字、摘要或模型记忆编造。

## 候选处理

- `ambiguous` 时调用 `human.request_input` 展示真实候选；`missing` Ingredient 进入 `missing_ingredient`，missing ready-like Food 进入 `missing_ready_food`。
- 多个缺失采购对象先说明整体缺口，再逐项创建一个 profile 草稿；每次审批只推进一个对象。
- 已有待买项与新需求相似时优先生成 update 或询问是否合并，不重复创建同名同单位项目。
- 单位优先使用 Ingredient 默认/支持单位或购物常用单位；不确定且影响数量时追问。

## Handoff

- `missing_ingredient`：typed `continuation` 指向 `ingredient_profile`，`requiredDraftType=ingredient_profile`，审批后恢复 `shopping_list`，state 使用 `shopping_missing_target.v1`。
- `missing_ready_food`：typed `continuation` 指向 `food_profile`，`requiredDraftType=food_profile`，审批后恢复 `shopping_list`，state 同样使用 `shopping_missing_target.v1`。
- state 只保留当前目标名、待处理名称和已解析实体 ID，不复制完整购物草稿。
- profile 审批成功后只恢复本 Skill，不自动生成或提交购物清单草稿。

## 审批规则

- 仅通过 `shopping.create_draft` 生成 `shopping_list` 草稿，遵循 `draft -> approval -> commit`。
- 修改、完成、恢复和删除都需要真实目标与版本；`set_done.payload.done` 只能为布尔值。
- 没有真实 Ingredient/Food ID、候选仍 ambiguous 或 profile 尚未确认时不得生成采购草稿。

## 用户反馈

- 草稿前说明采购对象绑定、库存扣除、待买项去重和 presence-only 项。
- 缺 profile 时先说明所有缺失对象与处理顺序，再逐项请求确认。
- 不把“候选找到”说成“已经加入”，不把 profile 审批说成购物清单已完成。
