---
name: recipe-draft
description: 创建、补全、更新、删除或收藏菜谱正文和结构化配方草稿，包括食材、步骤、份数、耗时和难度；不执行做菜扣库存、不记录餐食、不安排餐食计划。
---

# 菜谱管理 Skill

## 用户目标

- 查询、创建、补全、更新、删除或收藏结构化菜谱，包括食材、步骤、份数、耗时、难度和场景标签。
- 所有配料绑定当前家庭真实 Ingredient ID；缺失食材按顺序逐项补档并在每次审批后恢复当前菜谱工作流。

## 不适用范围

- 按菜谱做菜并扣库存交给 `recipe_cook`；做菜页现场问答交给 `cooking_assistant`。
- 不记录 MealLog、不安排餐食计划、不直接写正式 Recipe 或收藏关系。
- `ingredient.search` 和 `ingredient.resolve_candidates` 都只是候选召回，不能把语义候选自动绑定成真实身份。

## 工作模式

- `query`：搜索或读取真实菜谱并摘要，不生成草稿。
- `create`：根据用户目标构思结构，但进入草稿前必须批量解析所有正式配料并绑定真实 Ingredient ID。
- `update`：先读取完整真实菜谱，在现有结构上合成完整结构；payload 至少包含 `title`、`servings`、`prep_minutes`、`difficulty`、`ingredient_items` 和 `steps`。
- 删除和收藏先锁定真实目标，分别使用 `action=delete`、`action=set_favorite`；收藏 payload 只含 `favorite`。
- `difficulty` 只能是 `easy`、`medium`、`hard`；步骤图标优先 `pan`、`tomato`、`bowl`、`timer`、`tip`、`plate`。

## 前置条件

- 使用 `ingredient.resolve_candidates` 一次解析最多 30 个配料；`exact` 才可直接绑定，`candidate`/`ambiguous` 必须结合名称、分类、默认单位、备注、match reason 和上下文确认，`missing` 进入 handoff。
- `track_quantity` 食材使用真实 `defaultUnit`、`supportedUnits`、`unitConversions`；无法换算时追问或进入食材档案，不保留 unsupported unit。
- `not_track_quantity` 食材可以保留正式配料行但省略结构化 `quantity`/`unit`，把“少许/按口味”等写入 note 或步骤。
- 主要调料、辅料和蘸料也要进入候选解析；不能为了避免缺档案而全部藏进步骤。只有点缀、极少量可选调味才可只写备注。
- 当前消息图片只有在用户明确要求作为菜谱图或生成参考图时，才将 `currentAttachments` 中真实 `mediaId` 写入 `media_ids`；不得引用历史或跨家庭媒体。

## 候选处理

- 每个 `ingredient_items[].ingredient_id` 必须来自工具结果且名称一致，不能为空。
- ambiguous 时调用 `human.request_input` 让用户选择真实候选；missing 时先整体说明缺哪些主料/主要调料、为何需要补档，再按用户列出顺序逐项处理。
- 多菜谱任务按菜谱逐个闭环：解析本菜谱食材 -> 逐项确认缺失 Ingredient -> 生成本菜谱草稿 -> 再进入下一菜谱。不要先批量创建所有菜谱的缺失食材。
- 更新、删除、收藏目标不唯一或删除影响不清时展示真实候选/影响摘要。历史 artifact 需要完整步骤或配料时先调用 `workspace.read_artifact`。
- 图片归属不明或没有明确绑定意图时不传 `media_ids`。
- 仅用于识别或理解的图片不写入 `media_ids`；只有用户明确说“保存为菜谱图”或“作为生成参考图”时才绑定。

## Handoff

- `missing_ingredient`：每次只为当前缺失 Ingredient 创建一个 typed `continuation`，目标 `ingredient_profile`，`requiredDraftType=ingredient_profile`，审批后恢复 `recipe_draft`，state 使用 `recipe_missing_ingredient.v1`。
- state 只保存菜谱标题、当前缺失名、待处理名称和已确认 Ingredient ID，不复制完整菜谱 payload。
- 发现多个缺失项时先说明总体缺口，然后逐项审批；前一个 Ingredient 未确认前不得推进下一个，也不得生成 Recipe 草稿。
- 审批成功后只恢复 `recipe_draft`，由模型重新基于真实 ID 继续解析；运行时不自动生成或提交 Recipe 草稿。

## 审批规则

- 可先调用 `script.lint_recipe_draft` 做质量检查，但最终只能通过 `recipe.create_draft` 生成 `recipe` 草稿。
- 遵循 `draft -> approval -> commit`；新增、更新、删除、收藏都需要审批，确认前不写正式数据。
- 删除审批必须展示同步 Food、计划项、烹饪记录和媒体影响；后端 schema/Pydantic 校验是字段真相源。

## 用户反馈

- 草稿前说明菜谱结构、真实配料绑定结果、presence-only 配料和仍需确认的缺失项。
- 多菜谱任务开始前说明处理顺序和当前菜谱；每个缺失 Ingredient 审批前说明这是第几个以及确认后会恢复哪一步。
- 不把候选召回说成已绑定，不把 Ingredient 审批成功说成 Recipe 已生成。
